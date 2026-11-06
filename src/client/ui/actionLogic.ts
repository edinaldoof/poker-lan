import { formatChips } from '../../shared/format';
import type { LegalActions, PlayerActionRequest, PlayerStatus, Street } from '../../shared/protocol';
import { clamp } from './dom';

/* ---------------------------------------------------------------- raise sizing */

export type RaisePresetKey = 'min' | 'doubleBigBlind' | 'halfPot' | 'threeQuarterPot' | 'pot' | 'allIn';

export const RAISE_PRESET_KEYS: readonly RaisePresetKey[] = ['min', 'doubleBigBlind', 'halfPot', 'threeQuarterPot', 'pot', 'allIn'];

export interface RaisePresetContext {
  legal: LegalActions;
  currentBet: number;
  totalPot: number;
  bigBlind: number;
}

export function clampRaise(value: number, legal: LegalActions): number {
  return clamp(Math.round(value), legal.minRaiseTo, legal.maxRaiseTo);
}

/** Raise-to totals for the quick-size tokens, already clamped to the legal range. */
export function computeRaisePresets(context: RaisePresetContext): Record<RaisePresetKey, number> {
  const { legal, currentBet, totalPot, bigBlind } = context;
  const potAfterCall = totalPot + legal.callAmount;
  const double = legal.isOpeningBet ? Math.max(legal.minRaiseTo, 2 * bigBlind) : currentBet * 2;
  return {
    min: legal.minRaiseTo,
    doubleBigBlind: clampRaise(double, legal),
    halfPot: clampRaise(currentBet + 0.5 * potAfterCall, legal),
    threeQuarterPot: clampRaise(currentBet + 0.75 * potAfterCall, legal),
    pot: clampRaise(currentBet + potAfterCall, legal),
    allIn: legal.maxRaiseTo,
  };
}

const PRESET_LABELS: Record<RaisePresetKey, string> = {
  min: 'Mín.',
  doubleBigBlind: '2× BB',
  halfPot: '½ Pote',
  threeQuarterPot: '¾ Pote',
  pot: 'Pote',
  allIn: 'All-in',
};

/** Facing a bet the doubling token doubles that bet, so it must not claim to be two big blinds. */
export function presetLabel(key: RaisePresetKey, legal: LegalActions): string {
  if (key === 'doubleBigBlind' && !legal.isOpeningBet) return 'Dobro';
  return PRESET_LABELS[key];
}

export function presetsMatchingAmount(amount: number, presets: Record<RaisePresetKey, number>): RaisePresetKey[] {
  return RAISE_PRESET_KEYS.filter((key) => presets[key] === amount);
}

/** The all-in button must do what it says: with raising closed the engine would only turn it into a call. */
export function canGoAllIn(legal: LegalActions, stack: number): boolean {
  return legal.canRaise || (legal.canCall && legal.callAmount >= stack);
}

/** One step of the −/+ buttons: a big blind, kept inside the legal range. */
export function stepRaise(amount: number, direction: 1 | -1, step: number, legal: LegalActions): number {
  return clampRaise(amount + direction * step, legal);
}

/**
 * The last slider position is reserved for the all-in amount, so the thumb never sits at the end for a smaller
 * bet and never stops short of it when the range is not a multiple of the step.
 */
export function sliderPosition(amount: number, legal: LegalActions, step: number, steps: number): number {
  if (steps === 0) return 0;
  if (amount >= legal.maxRaiseTo) return steps;
  return clamp(Math.round((amount - legal.minRaiseTo) / step), 0, steps - 1);
}

export function amountAtSliderPosition(position: number, legal: LegalActions, step: number): number {
  return Math.min(legal.minRaiseTo + position * step, legal.maxRaiseTo);
}

/** Where each preset sits along the slider track, 0 to 1, for the tick marks. */
export function presetTickFractions(
  presets: Record<RaisePresetKey, number>,
  legal: LegalActions,
  step: number,
  steps: number,
): Record<RaisePresetKey, number> {
  const fractions = {} as Record<RaisePresetKey, number>;
  for (const key of RAISE_PRESET_KEYS) {
    fractions[key] = steps === 0 ? 0 : sliderPosition(presets[key], legal, step, steps) / steps;
  }
  return fractions;
}

/* ---------------------------------------------------------------- amounts in text */

const smallRatioFormatter = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const wholeRatioFormatter = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
const WHOLE_BIG_BLINDS_FROM = 100;

/** "2,5 BB": the same chips counted in big blinds, the unit players think in. */
export function formatBigBlinds(amount: number, bigBlind: number): string | null {
  if (bigBlind <= 0 || !Number.isFinite(amount)) return null;
  const ratio = amount / bigBlind;
  const formatter = ratio >= WHOLE_BIG_BLINDS_FROM ? wholeRatioFormatter : smallRatioFormatter;
  return `${formatter.format(ratio)} BB`;
}

/** Size of a bet or raise as a share of the pot it plays for, i.e. the pot after the call. */
export function formatPotShare(raiseTo: number, currentBet: number, potAfterCall: number): string | null {
  if (potAfterCall <= 0) return null;
  const percent = Math.round(((raiseTo - currentBet) / potAfterCall) * 100);
  return percent > 0 ? `${wholeRatioFormatter.format(percent)}% do pote` : null;
}

/* ---------------------------------------------------------------- button copy */

export interface ActionButtonModel {
  /** Small line above the figure: what the button does. */
  caption: string;
  /** The big line: an amount in chips, or the action itself when no chips move. */
  headline: string;
  /** Extra facts under the headline: the amount in big blinds, the share of the pot. */
  details: string[];
  /** Full accessible name; the visible lines are fragments. */
  spoken: string;
}

export interface ActionButtonsInput {
  legal: LegalActions;
  stack: number;
  raiseAmount: number;
  bigBlind: number;
  currentBet: number;
  totalPot: number;
  /** The raise controls are on screen, so pressing the raise button confirms instead of opening them. */
  raiseControlsOpen: boolean;
}

export interface ActionButtonsModel {
  fold: ActionButtonModel;
  call: ActionButtonModel;
  raise: ActionButtonModel;
  allIn: ActionButtonModel;
}

function bigBlindDetail(amount: number, bigBlind: number): string[] {
  const text = formatBigBlinds(amount, bigBlind);
  return text === null ? [] : [`= ${text}`];
}

function describeFold(): ActionButtonModel {
  return { caption: 'Desistir', headline: 'Fold', details: [], spoken: 'Fold, desistir da mão' };
}

function describeCall(input: ActionButtonsInput): ActionButtonModel {
  const { legal, stack, bigBlind } = input;
  if (legal.canCheck || !legal.canCall) {
    return { caption: 'Passar a vez', headline: 'Check', details: [], spoken: 'Check, passar a vez' };
  }
  const paid = Math.min(legal.callAmount, stack);
  const isAllIn = legal.callAmount >= stack;
  const details = bigBlindDetail(paid, bigBlind);
  const amountText = formatChips(paid);
  return {
    caption: isAllIn ? 'Pagar tudo' : 'Pagar',
    headline: amountText,
    details,
    spoken: [`${isAllIn ? 'Pagar tudo' : 'Pagar'} ${amountText} fichas`, ...details.map((detail) => detail.replace('= ', ''))].join(', '),
  };
}

export interface RaiseAmountFacts {
  bigBlinds: string | null;
  share: string | null;
}

export interface RaiseAmountInput {
  legal: LegalActions;
  raiseAmount: number;
  bigBlind: number;
  currentBet: number;
  totalPot: number;
}

/** What a raise-to amount means in the units players think in. Raising to the whole stack is simply an all-in. */
export function describeRaiseAmount(input: RaiseAmountInput): RaiseAmountFacts {
  const { legal, raiseAmount, bigBlind, currentBet, totalPot } = input;
  const share = raiseAmount >= legal.maxRaiseTo ? 'All-in' : formatPotShare(raiseAmount, currentBet, totalPot + legal.callAmount);
  const bigBlinds = formatBigBlinds(raiseAmount, bigBlind);
  return { bigBlinds: bigBlinds === null ? null : `= ${bigBlinds}`, share };
}

function describeRaise(input: ActionButtonsInput): ActionButtonModel {
  const { legal, raiseAmount, raiseControlsOpen } = input;
  if (!legal.canRaise) {
    return { caption: 'Aumentar', headline: '—', details: ['Aumento fechado'], spoken: 'Aumentar indisponível, aumento fechado' };
  }
  const verb = legal.isOpeningBet ? 'Apostar' : 'Aumentar para';
  const caption = raiseControlsOpen ? (legal.isOpeningBet ? 'Confirmar aposta' : 'Confirmar aumento') : verb;
  const facts = describeRaiseAmount(input);
  const details = [facts.bigBlinds, facts.share].filter((detail): detail is string => detail !== null);
  const amountText = formatChips(raiseAmount);
  return {
    caption,
    headline: amountText,
    details,
    spoken: [`${caption} ${amountText} fichas`, ...details.map((detail) => detail.replace('= ', ''))].join(', '),
  };
}

function describeAllIn(input: ActionButtonsInput): ActionButtonModel {
  const { legal, stack, bigBlind } = input;
  const amountText = formatChips(stack);
  if (!canGoAllIn(legal, stack)) {
    return { caption: 'All-in', headline: amountText, details: ['Indisponível agora'], spoken: 'All-in indisponível agora' };
  }
  const details = bigBlindDetail(stack, bigBlind);
  return {
    caption: 'All-in',
    headline: amountText,
    details,
    spoken: [`All-in ${amountText} fichas`, ...details.map((detail) => detail.replace('= ', ''))].join(', '),
  };
}

export function describeActionButtons(input: ActionButtonsInput): ActionButtonsModel {
  return { fold: describeFold(), call: describeCall(input), raise: describeRaise(input), allIn: describeAllIn(input) };
}

function joinOptions(options: string[]): string {
  if (options.length <= 1) return options.join('');
  return `${options.slice(0, -1).join(', ')} ou ${options[options.length - 1]}`;
}

/** Screen-reader text for the moment a decision appears; the visual cue is only a chime and a glow. */
export function describeTurn(legal: LegalActions): string {
  const options: string[] = [];
  if (legal.canCheck) options.push('dar check (C)');
  else if (legal.canCall) options.push(`pagar ${formatChips(legal.callAmount)} (C)`);
  if (legal.canRaise) options.push(`${legal.isOpeningBet ? 'apostar' : 'aumentar'} (R)`);
  if (legal.canFold) options.push('desistir (F)');
  return `Sua vez. Você pode ${joinOptions(options)}.`;
}

/* ---------------------------------------------------------------- answering */

export function resolveCallOrCheck(legal: LegalActions): PlayerActionRequest | null {
  if (legal.canCheck) return { type: 'check' };
  if (legal.canCall) return { type: 'call' };
  return null;
}

/** Raising to the whole stack is an all-in, which the server expects under that name. */
export function resolveRaiseRequest(legal: LegalActions, amount: number): PlayerActionRequest | null {
  if (!legal.canRaise) return null;
  return amount >= legal.maxRaiseTo ? { type: 'allIn' } : { type: 'raise', amount: clampRaise(amount, legal) };
}

export type ShortcutOutcome = { kind: 'submit'; request: PlayerActionRequest } | { kind: 'openRaise' } | null;

/** F, C, R and A act on the decision on screen right now; nothing is queued for a later turn. */
export function resolveShortcut(key: string, legal: LegalActions, stack: number): ShortcutOutcome {
  switch (key.toLowerCase()) {
    case 'f':
      return legal.canFold ? { kind: 'submit', request: { type: 'fold' } } : null;
    case 'c': {
      const request = resolveCallOrCheck(legal);
      return request === null ? null : { kind: 'submit', request };
    }
    case 'r':
      return legal.canRaise ? { kind: 'openRaise' } : null;
    case 'a':
      return canGoAllIn(legal, stack) ? { kind: 'submit', request: { type: 'allIn' } } : null;
    default:
      return null;
  }
}

/* ---------------------------------------------------------------- decisions and the action lock */

export const ACTION_LOCK_TIMEOUT_MS = 3000;

/**
 * Identifies one decision. The deadline is new for every turn, and the legal amounts guard against two decisions
 * that would otherwise look alike, so a lock taken for one can never hold the next.
 */
export function buildDecisionKey(handNumber: number, street: Street, turnDeadline: number | null, legal: LegalActions): string {
  return [handNumber, street, turnDeadline ?? 0, legal.callAmount, legal.minRaiseTo, legal.maxRaiseTo].join(':');
}

/**
 * A decision stops accepting input once the player has answered it (the server's reply may still be in the
 * presentation queue) or its deadline has passed (the server is already applying the automatic action).
 */
export function isDecisionActionable(decisionKey: string | null, lockedKey: string | null, remainingMs: number | null): boolean {
  if (decisionKey === null || decisionKey === lockedKey) return false;
  return remainingMs === null || remainingMs > 0;
}

export interface ActionLock {
  key: string;
  takenAtMs: number;
}

export function takeActionLock(decisionKey: string, nowMs: number): ActionLock {
  return { key: decisionKey, takenAtMs: nowMs };
}

/**
 * The lock ends with the decision it was taken for (the turn or the legal actions changed) or after the safety
 * timeout. Unrelated notices such as a reconnect message never end it; the one error that may is handled by the
 * caller, because only it knows the error answered this very action.
 */
export function reconcileActionLock(lock: ActionLock | null, currentDecisionKey: string | null, nowMs: number): ActionLock | null {
  if (lock === null) return null;
  if (lock.key !== currentDecisionKey) return null;
  return nowMs - lock.takenAtMs >= ACTION_LOCK_TIMEOUT_MS ? null : lock;
}

/* ---------------------------------------------------------------- countdown */

export type CountdownLevel = 'ok' | 'warn' | 'urgent';

export const COUNTDOWN_WARN_MS = 10_000;
export const COUNTDOWN_URGENT_MS = 5_000;

export function countdownLevel(remainingMs: number): CountdownLevel {
  if (remainingMs <= COUNTDOWN_URGENT_MS) return 'urgent';
  if (remainingMs <= COUNTDOWN_WARN_MS) return 'warn';
  return 'ok';
}

/* ---------------------------------------------------------------- pre-actions */

export type PreActionKind = 'checkFold' | 'check' | 'callAny';

export const PRE_ACTION_KINDS: readonly PreActionKind[] = ['checkFold', 'check', 'callAny'];

export const PRE_ACTION_LABELS: Record<PreActionKind, string> = {
  checkFold: 'Check/Fold',
  check: 'Check',
  callAny: 'Pagar qualquer',
};

export interface PreActionContext {
  handNumber: number;
  street: Street;
  currentBet: number;
}

export interface ArmedPreAction {
  kind: PreActionKind;
  /** The table as it was when the player chose; the choice only holds for that hand, street and bet. */
  context: PreActionContext;
}

export type PreActionClearReason = 'newHand' | 'newStreet' | 'betChanged' | 'unavailable';

const BETTING_STREETS: ReadonlySet<Street> = new Set<Street>(['preflop', 'flop', 'turn', 'river']);

export interface PreActionAvailabilityInput {
  street: Street;
  status: PlayerStatus;
  cardCount: number;
  hasDecision: boolean;
}

/** Pre-actions exist for a player who still holds cards in a betting round and has nothing to decide right now. */
export function canArmPreAction(input: PreActionAvailabilityInput): boolean {
  return !input.hasDecision && input.status === 'active' && input.cardCount > 0 && BETTING_STREETS.has(input.street);
}

/** Choosing a second option replaces the first; choosing the armed one switches it off. */
export function togglePreAction(armed: ArmedPreAction | null, kind: PreActionKind, context: PreActionContext): ArmedPreAction | null {
  if (armed?.kind === kind) return null;
  return { kind, context };
}

export function preActionClearReason(
  armed: ArmedPreAction,
  context: PreActionContext,
  available: boolean,
): PreActionClearReason | null {
  if (!available) return 'unavailable';
  if (armed.context.handNumber !== context.handNumber) return 'newHand';
  if (armed.context.street !== context.street) return 'newStreet';
  if (armed.kind === 'check' && armed.context.currentBet !== context.currentBet) return 'betChanged';
  return null;
}

export function reconcilePreAction(armed: ArmedPreAction | null, context: PreActionContext, available: boolean): ArmedPreAction | null {
  if (armed === null) return null;
  return preActionClearReason(armed, context, available) === null ? armed : null;
}

/** What each option does once the turn arrives; null means it no longer applies and is simply dropped. */
export function resolvePreAction(kind: PreActionKind, legal: LegalActions): PlayerActionRequest | null {
  switch (kind) {
    case 'checkFold':
      if (legal.canCheck) return { type: 'check' };
      return legal.canFold ? { type: 'fold' } : null;
    case 'check':
      return legal.canCheck ? { type: 'check' } : null;
    case 'callAny':
      if (legal.canCall) return { type: 'call' };
      return legal.canCheck ? { type: 'check' } : null;
  }
}

/** The request to send the moment the turn starts, or null when nothing is armed or what was armed is stale. */
export function takePreActionRequest(
  armed: ArmedPreAction | null,
  context: PreActionContext,
  legal: LegalActions,
): PlayerActionRequest | null {
  if (armed === null || preActionClearReason(armed, context, true) !== null) return null;
  return resolvePreAction(armed.kind, legal);
}

export function describePreAction(kind: PreActionKind | null): string {
  switch (kind) {
    case null:
      return 'Escolha uma jogada para fazer sozinho quando chegar a sua vez.';
    case 'checkFold':
      return 'Na sua vez: check se puder, senão fold.';
    case 'check':
      return 'Na sua vez: check, se ninguém apostar até lá.';
    case 'callAny':
      return 'Na sua vez: pagar qualquer aposta, ou check se não houver.';
  }
}

export function describePreActionClearReason(kind: PreActionKind, reason: PreActionClearReason): string | null {
  if (reason === 'betChanged') return `${PRE_ACTION_LABELS[kind]} cancelado: a aposta mudou.`;
  return null;
}

const REQUEST_VERBS: Record<PlayerActionRequest['type'], string> = {
  fold: 'fold',
  check: 'check',
  call: 'pagar',
  raise: 'aumentar',
  allIn: 'all-in',
};

export function describePreActionResult(kind: PreActionKind, request: PlayerActionRequest): string {
  return `Sua vez. ${PRE_ACTION_LABELS[kind]} executado: ${REQUEST_VERBS[request.type]}.`;
}
