import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as actionBarModule from '../src/client/ui/ActionBar';
import {
  ACTION_LOCK_TIMEOUT_MS,
  amountAtSliderPosition,
  buildDecisionKey,
  canArmPreAction,
  canGoAllIn,
  computeRaisePresets,
  countdownLevel,
  describeActionButtons,
  describePreAction,
  describePreActionClearReason,
  describePreActionResult,
  describeRaiseAmount,
  describeTurn,
  formatBigBlinds,
  formatPotShare,
  isDecisionActionable,
  preActionClearReason,
  presetLabel,
  presetTickFractions,
  presetsMatchingAmount,
  reconcileActionLock,
  reconcilePreAction,
  resolveCallOrCheck,
  resolvePreAction,
  resolveRaiseRequest,
  resolveShortcut,
  sliderPosition,
  stepRaise,
  takeActionLock,
  takePreActionRequest,
  togglePreAction,
  type ActionButtonsInput,
  type ArmedPreAction,
  type PreActionContext,
} from '../src/client/ui/actionLogic';
import type { LegalActions } from '../src/shared/protocol';

function legalActions(overrides: Partial<LegalActions> = {}): LegalActions {
  return {
    canFold: true,
    canCheck: false,
    canCall: true,
    callAmount: 40,
    canRaise: true,
    minRaiseTo: 80,
    maxRaiseTo: 1000,
    isOpeningBet: false,
    ...overrides,
  };
}

function preActionContext(overrides: Partial<PreActionContext> = {}): PreActionContext {
  return { handNumber: 7, street: 'flop', currentBet: 0, ...overrides };
}

function armed(kind: ArmedPreAction['kind'], overrides: Partial<PreActionContext> = {}): ArmedPreAction {
  return { kind, context: preActionContext(overrides) };
}

describe('public surface kept for the HUD', () => {
  it('still exposes the helpers other modules and older tests import from the action bar', () => {
    expect(actionBarModule.canGoAllIn).toBe(canGoAllIn);
    expect(actionBarModule.resolveCallOrCheck).toBe(resolveCallOrCheck);
    expect(actionBarModule.isDecisionActionable).toBe(isDecisionActionable);
    expect(actionBarModule.describeTurn).toBe(describeTurn);
    expect(typeof actionBarModule.ActionBar).toBe('function');
  });

  it('frees the lock only through the answer to the player own action, never through a generic error toast', () => {
    const prototype = actionBarModule.ActionBar.prototype as unknown as Record<string, unknown>;
    expect(typeof prototype.handleActionError).toBe('function');
    expect(prototype.releaseLock).toBeUndefined();
  });
});

describe('all-in availability', () => {
  it('is offered whenever the player can raise, because it raises to the whole stack', () => {
    expect(canGoAllIn(legalActions({ canRaise: true }), 1000)).toBe(true);
  });

  it('is withheld when raising is closed and the call would not commit the whole stack', () => {
    // The engine turns an all-in into a plain call here, so the button would promise something it cannot do.
    const answerToShortShove = legalActions({ canRaise: false, callAmount: 480 });

    expect(canGoAllIn(answerToShortShove, 1480)).toBe(false);
  });

  it('is offered when raising is closed but the call is already the whole stack', () => {
    const shortStackFacingBigBet = legalActions({ canRaise: false, callAmount: 300 });

    expect(canGoAllIn(shortStackFacingBigBet, 300)).toBe(true);
  });

  it('is withheld when the player can only check', () => {
    const optionWithNobodyToRaiseAgainst = legalActions({ canCheck: true, canCall: false, callAmount: 0, canRaise: false });

    expect(canGoAllIn(optionWithNobodyToRaiseAgainst, 500)).toBe(false);
  });
});

describe('call and check shortcut', () => {
  it('checks when there is nothing to pay', () => {
    expect(resolveCallOrCheck(legalActions({ canCheck: true, canCall: false, callAmount: 0 }))).toEqual({ type: 'check' });
  });

  it('calls when a bet has to be paid', () => {
    expect(resolveCallOrCheck(legalActions({ canCheck: false, canCall: true }))).toEqual({ type: 'call' });
  });

  it('sends nothing when neither is legal', () => {
    expect(resolveCallOrCheck(legalActions({ canCheck: false, canCall: false }))).toBeNull();
  });
});

describe('raise presets', () => {
  const opening = legalActions({
    canCheck: true,
    canCall: false,
    callAmount: 0,
    isOpeningBet: true,
    minRaiseTo: 20,
    maxRaiseTo: 2000,
  });
  const facingBet = legalActions({ callAmount: 100, minRaiseTo: 200, maxRaiseTo: 1500 });

  it('sizes an opening bet from the pot and the big blind', () => {
    const presets = computeRaisePresets({ legal: opening, currentBet: 0, totalPot: 120, bigBlind: 20 });

    expect(presets).toEqual({ min: 20, doubleBigBlind: 40, halfPot: 60, threeQuarterPot: 90, pot: 120, allIn: 2000 });
  });

  it('sizes a raise from the pot after calling, on top of the current bet', () => {
    // 150 in the middle plus the 100 to call: the pot a raise plays for is 250.
    const presets = computeRaisePresets({ legal: facingBet, currentBet: 100, totalPot: 150, bigBlind: 20 });

    expect(presets).toEqual({ min: 200, doubleBigBlind: 200, halfPot: 225, threeQuarterPot: 288, pot: 350, allIn: 1500 });
  });

  it('keeps every preset inside the legal range, whole chips only', () => {
    const shortStack = legalActions({ callAmount: 100, minRaiseTo: 200, maxRaiseTo: 260 });
    const presets = computeRaisePresets({ legal: shortStack, currentBet: 100, totalPot: 150, bigBlind: 20 });

    for (const amount of Object.values(presets)) {
      expect(amount).toBeGreaterThanOrEqual(200);
      expect(amount).toBeLessThanOrEqual(260);
      expect(Number.isInteger(amount)).toBe(true);
    }
    expect(presets.pot).toBe(260);
  });

  it('names the doubling token after what it really doubles', () => {
    expect(presetLabel('doubleBigBlind', opening)).toBe('2× BB');
    expect(presetLabel('doubleBigBlind', facingBet)).toBe('Dobro');
    expect(presetLabel('threeQuarterPot', facingBet)).toBe('¾ Pote');
  });

  it('highlights every preset that equals the amount on screen', () => {
    const presets = computeRaisePresets({ legal: facingBet, currentBet: 100, totalPot: 150, bigBlind: 20 });

    expect(presetsMatchingAmount(200, presets)).toEqual(['min', 'doubleBigBlind']);
    expect(presetsMatchingAmount(201, presets)).toEqual([]);
  });
});

describe('big-blind steps', () => {
  const legal = legalActions({ minRaiseTo: 80, maxRaiseTo: 130 });

  it('moves the amount by one big blind', () => {
    expect(stepRaise(100, 1, 20, legal)).toBe(120);
    expect(stepRaise(100, -1, 20, legal)).toBe(80);
  });

  it('never leaves the legal range', () => {
    expect(stepRaise(125, 1, 20, legal)).toBe(130);
    expect(stepRaise(90, -1, 20, legal)).toBe(80);
  });
});

describe('slider position', () => {
  const shortStack = legalActions({ minRaiseTo: 40, maxRaiseTo: 62 });
  const step = 10;
  const steps = Math.ceil((shortStack.maxRaiseTo - shortStack.minRaiseTo) / step);

  it('puts the thumb at the end when the amount is the all-in, even if the range is not a multiple of the step', () => {
    expect(steps).toBe(3);
    expect(sliderPosition(62, shortStack, step, steps)).toBe(3);
  });

  it('maps amounts below the all-in to the nearest earlier position', () => {
    expect(sliderPosition(40, shortStack, step, steps)).toBe(0);
    expect(sliderPosition(50, shortStack, step, steps)).toBe(1);
    expect(sliderPosition(61, shortStack, step, steps)).toBe(2);
  });

  it('keeps the end of the slider for the all-in alone when rounding would reach it early', () => {
    const wideRange = legalActions({ minRaiseTo: 40, maxRaiseTo: 68 });
    const wideSteps = Math.ceil((wideRange.maxRaiseTo - wideRange.minRaiseTo) / step);

    expect(sliderPosition(65, wideRange, step, wideSteps)).toBe(wideSteps - 1);
    expect(sliderPosition(68, wideRange, step, wideSteps)).toBe(wideSteps);
  });

  it('stays at the start when there is nothing to slide', () => {
    expect(sliderPosition(100, legalActions({ minRaiseTo: 100, maxRaiseTo: 100 }), step, 0)).toBe(0);
  });

  it('turns a thumb position back into an amount that never passes the all-in', () => {
    expect(amountAtSliderPosition(0, shortStack, step)).toBe(40);
    expect(amountAtSliderPosition(2, shortStack, step)).toBe(60);
    expect(amountAtSliderPosition(3, shortStack, step)).toBe(62);
  });

  it('places the preset ticks along the track from the minimum to the all-in', () => {
    const legal = legalActions({ minRaiseTo: 100, maxRaiseTo: 500 });
    const presets = computeRaisePresets({ legal, currentBet: 50, totalPot: 100, bigBlind: 20 });
    const fractions = presetTickFractions(presets, legal, 10, 40);

    expect(fractions.min).toBe(0);
    expect(fractions.allIn).toBe(1);
    expect(fractions.halfPot).toBeGreaterThan(fractions.min);
    expect(fractions.pot).toBeGreaterThan(fractions.halfPot);
    expect(fractions.pot).toBeLessThan(1);
  });
});

describe('amounts in big blinds and share of the pot', () => {
  it('writes big blinds the Brazilian way, with one decimal when it matters', () => {
    expect(formatBigBlinds(50, 20)).toBe('2,5 BB');
    expect(formatBigBlinds(40, 20)).toBe('2 BB');
    expect(formatBigBlinds(1240, 20)).toBe('62 BB');
  });

  it('drops the decimals once the stack is deep', () => {
    expect(formatBigBlinds(2500, 20)).toBe('125 BB');
  });

  it('says nothing when the blind is unknown', () => {
    expect(formatBigBlinds(100, 0)).toBeNull();
  });

  it('measures a raise against the pot after the call, not against the raise-to total', () => {
    // Raising to 288 over a bet of 100 adds 188 to a pot of 250.
    expect(formatPotShare(288, 100, 250)).toBe('75% do pote');
    expect(formatPotShare(40, 0, 40)).toBe('100% do pote');
  });

  it('says nothing when there is no pot to compare with or the amount adds nothing', () => {
    expect(formatPotShare(40, 0, 0)).toBeNull();
    expect(formatPotShare(100, 100, 250)).toBeNull();
  });

  it('calls a raise to the whole stack an all-in instead of a pot share', () => {
    const legal = legalActions({ minRaiseTo: 200, maxRaiseTo: 1500 });
    const facts = describeRaiseAmount({ legal, raiseAmount: 1500, bigBlind: 20, currentBet: 100, totalPot: 150 });

    expect(facts).toEqual({ bigBlinds: '= 75 BB', share: 'All-in' });
  });
});

describe('button copy', () => {
  function buttons(legalOverrides: Partial<LegalActions>, inputOverrides: Partial<ActionButtonsInput> = {}) {
    return describeActionButtons({
      legal: legalActions(legalOverrides),
      stack: 1000,
      raiseAmount: 80,
      bigBlind: 20,
      currentBet: 40,
      totalPot: 70,
      raiseControlsOpen: false,
      ...inputOverrides,
    });
  }

  it('shows the amount to pay in chips and in big blinds', () => {
    const { call } = buttons({ callAmount: 50 });

    expect(call).toMatchObject({ caption: 'Pagar', headline: '50', details: ['= 2,5 BB'] });
  });

  it('offers a check when nothing has to be paid', () => {
    const { call } = buttons({ canCheck: true, canCall: false, callAmount: 0 });

    expect(call).toMatchObject({ caption: 'Passar a vez', headline: 'Check', details: [] });
  });

  it('pays only what the stack holds and says it is everything', () => {
    const { call } = buttons({ callAmount: 480 }, { stack: 300 });

    expect(call).toMatchObject({ caption: 'Pagar tudo', headline: '300' });
  });

  it('says what a raise adds up to, in chips, big blinds and share of the pot', () => {
    const { raise } = buttons({ minRaiseTo: 80 }, { raiseAmount: 120 });

    // 80 more over a pot of 70 plus the 40 to call.
    expect(raise).toMatchObject({ caption: 'Aumentar para', headline: '120', details: ['= 6 BB', '73% do pote'] });
  });

  it('calls it a bet when nobody has bet yet', () => {
    const { raise } = buttons({ isOpeningBet: true, canCheck: true, canCall: false, callAmount: 0 }, { currentBet: 0, raiseAmount: 40 });

    expect(raise.caption).toBe('Apostar');
  });

  it('turns the raise button into a confirmation once its controls are open', () => {
    expect(buttons({}, { raiseControlsOpen: true }).raise.caption).toBe('Confirmar aumento');
    expect(buttons({ isOpeningBet: true }, { raiseControlsOpen: true }).raise.caption).toBe('Confirmar aposta');
  });

  it('reports a raise to the whole stack as an all-in', () => {
    const { raise } = buttons({ minRaiseTo: 80, maxRaiseTo: 1000 }, { raiseAmount: 1000 });

    expect(raise.details).toContain('All-in');
  });

  it('explains why raising is not available', () => {
    const { raise } = buttons({ canRaise: false });

    expect(raise.details).toEqual(['Aumento fechado']);
  });

  it('shows the whole stack on the all-in button and explains when it cannot be used', () => {
    expect(buttons({}).allIn).toMatchObject({ caption: 'All-in', headline: '1.000', details: ['= 50 BB'] });
    expect(buttons({ canRaise: false, callAmount: 200 }).allIn.details).toEqual(['Indisponível agora']);
  });

  it('gives every button a spoken name that carries its amounts', () => {
    const { raise, call, fold } = buttons({ callAmount: 50 }, { raiseAmount: 120 });

    expect(raise.spoken).toBe('Aumentar para 120 fichas, 6 BB, 67% do pote');
    expect(call.spoken).toBe('Pagar 50 fichas, 2,5 BB');
    expect(fold.spoken).toBe('Fold, desistir da mão');
  });
});

describe('answering with the keyboard', () => {
  const stack = 1000;

  it('folds on F, but only when folding is legal', () => {
    expect(resolveShortcut('f', legalActions(), stack)).toEqual({ kind: 'submit', request: { type: 'fold' } });
    expect(resolveShortcut('F', legalActions({ canFold: false }), stack)).toBeNull();
  });

  it('checks or calls on C, whichever the table allows', () => {
    expect(resolveShortcut('c', legalActions(), stack)).toEqual({ kind: 'submit', request: { type: 'call' } });
    expect(resolveShortcut('c', legalActions({ canCheck: true, canCall: false }), stack)).toEqual({
      kind: 'submit',
      request: { type: 'check' },
    });
  });

  it('opens the raise controls on R instead of raising at once', () => {
    expect(resolveShortcut('r', legalActions(), stack)).toEqual({ kind: 'openRaise' });
    expect(resolveShortcut('r', legalActions({ canRaise: false }), stack)).toBeNull();
  });

  it('goes all-in on A only when that is a real all-in', () => {
    expect(resolveShortcut('a', legalActions(), stack)).toEqual({ kind: 'submit', request: { type: 'allIn' } });
    expect(resolveShortcut('a', legalActions({ canRaise: false, callAmount: 200 }), stack)).toBeNull();
  });

  it('ignores every other key', () => {
    expect(resolveShortcut('x', legalActions(), stack)).toBeNull();
    expect(resolveShortcut('Tab', legalActions(), stack)).toBeNull();
  });

  it('confirms a raise to the whole stack as an all-in and anything lower as a raise', () => {
    const legal = legalActions({ minRaiseTo: 80, maxRaiseTo: 1000 });

    expect(resolveRaiseRequest(legal, 1000)).toEqual({ type: 'allIn' });
    expect(resolveRaiseRequest(legal, 250)).toEqual({ type: 'raise', amount: 250 });
    expect(resolveRaiseRequest(legal, 5)).toEqual({ type: 'raise', amount: 80 });
    expect(resolveRaiseRequest(legalActions({ canRaise: false }), 250)).toBeNull();
  });
});

describe('when a decision accepts input', () => {
  const key = '12:preflop:1700000030000:40:80:1000';

  it('accepts input while the turn is open', () => {
    expect(isDecisionActionable(key, null, 12_000)).toBe(true);
  });

  it('stays closed after the player answered, however long the server takes to confirm', () => {
    // The answer's round trip includes the animation queue: a timer-based unlock let a second press reach a later turn.
    expect(isDecisionActionable(key, key, 25_000)).toBe(false);
  });

  it('opens again for the next decision', () => {
    expect(isDecisionActionable('12:flop:1700000060000:0:20:1000', key, 30_000)).toBe(true);
  });

  it('closes once the deadline has passed, because the server is already applying the automatic action', () => {
    expect(isDecisionActionable(key, null, 0)).toBe(false);
    expect(isDecisionActionable(key, null, -300)).toBe(false);
  });

  it('accepts input when no deadline is known', () => {
    expect(isDecisionActionable(key, null, null)).toBe(true);
  });

  it('ignores presses when there is no decision', () => {
    expect(isDecisionActionable(null, null, 10_000)).toBe(false);
  });
});

describe('identity of a decision', () => {
  const legal = legalActions();

  it('differs for every turn, even within the same street', () => {
    const first = buildDecisionKey(12, 'preflop', 1_700_000_030_000, legal);
    const second = buildDecisionKey(12, 'preflop', 1_700_000_060_000, legal);

    expect(first).not.toBe(second);
  });

  it('differs when the legal actions changed behind the same deadline', () => {
    const before = buildDecisionKey(12, 'flop', 1_700_000_030_000, legal);
    const after = buildDecisionKey(12, 'flop', 1_700_000_030_000, legalActions({ callAmount: 120, minRaiseTo: 240 }));

    expect(before).not.toBe(after);
  });

  it('is stable when the same snapshot arrives twice', () => {
    expect(buildDecisionKey(12, 'flop', 1_700_000_030_000, legal)).toBe(buildDecisionKey(12, 'flop', 1_700_000_030_000, { ...legal }));
  });
});

describe('the lock after an answer', () => {
  const key = '12:preflop:1700000030000:40:80:1000';
  const takenAt = 1_000_000;

  it('holds while the same decision is still on screen', () => {
    const lock = takeActionLock(key, takenAt);

    expect(reconcileActionLock(lock, key, takenAt + 1_500)).toEqual(lock);
  });

  it('is released by a new decision, whatever the clock says', () => {
    const lock = takeActionLock(key, takenAt);

    expect(reconcileActionLock(lock, '12:flop:1700000090000:0:20:1000', takenAt + 10)).toBeNull();
  });

  it('is released when the decision is gone', () => {
    expect(reconcileActionLock(takeActionLock(key, takenAt), null, takenAt + 10)).toBeNull();
  });

  it('is released by the safety timeout when no reply ever arrives', () => {
    const lock = takeActionLock(key, takenAt);

    expect(reconcileActionLock(lock, key, takenAt + ACTION_LOCK_TIMEOUT_MS - 1)).toEqual(lock);
    expect(reconcileActionLock(lock, key, takenAt + ACTION_LOCK_TIMEOUT_MS)).toBeNull();
  });

  it('stays released once there is nothing to hold', () => {
    expect(reconcileActionLock(null, key, takenAt)).toBeNull();
  });

  it('waits three seconds before giving up', () => {
    expect(ACTION_LOCK_TIMEOUT_MS).toBe(3000);
  });
});

describe('countdown colour', () => {
  it('stays calm until the last ten seconds', () => {
    expect(countdownLevel(30_000)).toBe('ok');
    expect(countdownLevel(10_001)).toBe('ok');
  });

  it('warns under ten seconds', () => {
    expect(countdownLevel(10_000)).toBe('warn');
    expect(countdownLevel(5_001)).toBe('warn');
  });

  it('turns urgent, and pulses, under five seconds', () => {
    expect(countdownLevel(5_000)).toBe('urgent');
    expect(countdownLevel(0)).toBe('urgent');
  });
});

describe('who may arm a pre-action', () => {
  const holdingCards = { street: 'flop', status: 'active', cardCount: 2, hasDecision: false } as const;

  it('is available to a player who holds cards in a betting round and waits for the turn', () => {
    expect(canArmPreAction(holdingCards)).toBe(true);
  });

  it('is not offered when it is already the player\'s turn', () => {
    expect(canArmPreAction({ ...holdingCards, hasDecision: true })).toBe(false);
  });

  it('is not offered to a player who folded, is all-in, or has no cards', () => {
    expect(canArmPreAction({ ...holdingCards, status: 'folded' })).toBe(false);
    expect(canArmPreAction({ ...holdingCards, status: 'allIn' })).toBe(false);
    expect(canArmPreAction({ ...holdingCards, cardCount: 0 })).toBe(false);
  });

  it('is not offered between hands or at the showdown', () => {
    expect(canArmPreAction({ ...holdingCards, street: 'idle' })).toBe(false);
    expect(canArmPreAction({ ...holdingCards, street: 'showdown' })).toBe(false);
  });
});

describe('choosing a pre-action', () => {
  const context = preActionContext();

  it('arms the chosen option', () => {
    expect(togglePreAction(null, 'check', context)).toEqual(armed('check'));
  });

  it('replaces the armed option when another is chosen, so only one is armed at a time', () => {
    expect(togglePreAction(armed('check'), 'callAny', context)).toEqual(armed('callAny'));
  });

  it('switches the armed option off when it is chosen again', () => {
    expect(togglePreAction(armed('checkFold'), 'checkFold', context)).toBeNull();
  });
});

describe('what a pre-action does when the turn arrives', () => {
  const nothingToPay = legalActions({ canCheck: true, canCall: false, callAmount: 0 });
  const facingBet = legalActions({ canCheck: false, canCall: true, callAmount: 60 });

  it('Check/Fold checks when it is free and folds when a bet has to be paid', () => {
    expect(resolvePreAction('checkFold', nothingToPay)).toEqual({ type: 'check' });
    expect(resolvePreAction('checkFold', facingBet)).toEqual({ type: 'fold' });
  });

  it('Check checks when it is free and does nothing when a bet appeared', () => {
    expect(resolvePreAction('check', nothingToPay)).toEqual({ type: 'check' });
    expect(resolvePreAction('check', facingBet)).toBeNull();
  });

  it('Pagar qualquer calls whatever the bet is, and checks when there is none', () => {
    expect(resolvePreAction('callAny', facingBet)).toEqual({ type: 'call' });
    expect(resolvePreAction('callAny', legalActions({ callAmount: 900 }))).toEqual({ type: 'call' });
    expect(resolvePreAction('callAny', nothingToPay)).toEqual({ type: 'check' });
  });

  it('does nothing when no move it knows is legal', () => {
    const nothing = legalActions({ canFold: false, canCheck: false, canCall: false });

    expect(resolvePreAction('checkFold', nothing)).toBeNull();
    expect(resolvePreAction('callAny', nothing)).toBeNull();
  });
});

describe('when a pre-action is cleared', () => {
  const context = preActionContext({ currentBet: 20 });

  it('survives while the hand, the street and (for Check) the bet are unchanged', () => {
    expect(reconcilePreAction(armed('check', { currentBet: 20 }), context, true)).toEqual(armed('check', { currentBet: 20 }));
  });

  it('is cleared at a new street', () => {
    const cleared = reconcilePreAction(armed('callAny', { street: 'preflop', currentBet: 20 }), context, true);

    expect(cleared).toBeNull();
    expect(preActionClearReason(armed('callAny', { street: 'preflop' }), context, true)).toBe('newStreet');
  });

  it('is cleared at a new hand', () => {
    expect(preActionClearReason(armed('checkFold', { handNumber: 6, currentBet: 20 }), context, true)).toBe('newHand');
  });

  it('clears Check when the bet to call changes', () => {
    expect(preActionClearReason(armed('check', { currentBet: 0 }), context, true)).toBe('betChanged');
  });

  it('keeps Check/Fold and Pagar qualquer when the bet changes, because both still make sense', () => {
    expect(preActionClearReason(armed('checkFold', { currentBet: 0 }), context, true)).toBeNull();
    expect(preActionClearReason(armed('callAny', { currentBet: 0 }), context, true)).toBeNull();
  });

  it('is cleared when the player can no longer use it, for instance after folding', () => {
    expect(preActionClearReason(armed('callAny', { currentBet: 20 }), context, false)).toBe('unavailable');
  });

  it('only explains the cancellation the player could not foresee', () => {
    expect(describePreActionClearReason('check', 'betChanged')).toBe('Check cancelado: a aposta mudou.');
    expect(describePreActionClearReason('check', 'newStreet')).toBeNull();
  });
});

describe('running the armed pre-action once the turn starts', () => {
  const context = preActionContext({ currentBet: 0 });
  const nothingToPay = legalActions({ canCheck: true, canCall: false, callAmount: 0 });

  it('sends the move that matches the table now', () => {
    expect(takePreActionRequest(armed('checkFold'), context, nothingToPay)).toEqual({ type: 'check' });
    expect(takePreActionRequest(armed('callAny'), context, legalActions({ callAmount: 60 }))).toEqual({ type: 'call' });
  });

  it('sends nothing when nothing is armed', () => {
    expect(takePreActionRequest(null, context, nothingToPay)).toBeNull();
  });

  it('never runs a choice made in an earlier hand or street', () => {
    expect(takePreActionRequest(armed('checkFold', { street: 'preflop' }), context, nothingToPay)).toBeNull();
    expect(takePreActionRequest(armed('callAny', { handNumber: 6 }), context, nothingToPay)).toBeNull();
  });

  it('never runs Check once the bet changed, even though checking happens to be legal', () => {
    const betWhenChosen = armed('check', { currentBet: 40 });

    expect(takePreActionRequest(betWhenChosen, context, nothingToPay)).toBeNull();
  });
});

describe('pre-action wording', () => {
  it('tells which option is armed and what it will do', () => {
    expect(describePreAction('checkFold')).toBe('Na sua vez: check se puder, senão fold.');
    expect(describePreAction('callAny')).toBe('Na sua vez: pagar qualquer aposta, ou check se não houver.');
  });

  it('invites a choice when nothing is armed', () => {
    expect(describePreAction(null)).toContain('Escolha');
  });

  it('announces what the armed option did', () => {
    expect(describePreActionResult('checkFold', { type: 'fold' })).toBe('Sua vez. Check/Fold executado: fold.');
    expect(describePreActionResult('callAny', { type: 'call' })).toBe('Sua vez. Pagar qualquer executado: pagar.');
  });
});

describe('turn announcement for screen readers', () => {
  it('lists check, bet and fold when nobody has bet', () => {
    const opening = legalActions({ canCheck: true, canCall: false, callAmount: 0, isOpeningBet: true });

    expect(describeTurn(opening)).toBe('Sua vez. Você pode dar check (C), apostar (R) ou desistir (F).');
  });

  it('lists the amount to pay, raise and fold when facing a bet', () => {
    expect(describeTurn(legalActions({ callAmount: 1240 }))).toBe(
      'Sua vez. Você pode pagar 1.240 (C), aumentar (R) ou desistir (F).',
    );
  });

  it('omits raising when it is closed', () => {
    expect(describeTurn(legalActions({ canRaise: false, callAmount: 480 }))).toBe(
      'Sua vez. Você pode pagar 480 (C) ou desistir (F).',
    );
  });
});

describe('compact action bar stylesheet', () => {
  const css = readFileSync(new URL('../src/client/ui/actionBar.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  it('keeps the hooks the HUD and the tests rely on', () => {
    expect(css).toContain(".action-bar[data-turn='mine']");
    expect(css).toContain('.action-bar__timer');
    for (const token of ['--act-fold', '--act-check', '--act-call', '--act-bet', '--act-raise', '--act-allin']) expect(css).toContain(token);
  });

  it('restores 44 px targets for the raise steppers and the slider on touch screens', () => {
    const coarse = css.slice(css.indexOf('@media (pointer: coarse) {'));
    expect(coarse).toMatch(/\.raise-stepper \{\s*width: 44px;\s*height: 44px;/);
    expect(coarse).toMatch(/\.raise-slider__input \{\s*height: 44px;/);
  });

  it('docks the wide-screen strip beyond the lower-right seat plate, never wider than 540 px', () => {
    expect(css).toMatch(/width: clamp\(310px, calc\(50vw - 43vh - 20px\), 540px\);/);
  });
});
