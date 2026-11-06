import './actionBar.css';
import { formatChips } from '../../shared/format';
import type { LegalActions, PlayerActionRequest, SeatView, TableView } from '../../shared/protocol';
import type { AudioManager } from '../audio/AudioManager';
import {
  ACTION_LOCK_TIMEOUT_MS,
  RAISE_PRESET_KEYS,
  amountAtSliderPosition,
  buildDecisionKey,
  canArmPreAction,
  canGoAllIn,
  clampRaise,
  computeRaisePresets,
  countdownLevel,
  describeActionButtons,
  describePreAction,
  describePreActionClearReason,
  describePreActionResult,
  describeRaiseAmount,
  describeTurn,
  isDecisionActionable,
  presetLabel,
  presetTickFractions,
  presetsMatchingAmount,
  preActionClearReason,
  reconcileActionLock,
  resolveRaiseRequest,
  resolveCallOrCheck,
  resolveShortcut,
  sliderPosition,
  stepRaise,
  takeActionLock,
  takePreActionRequest,
  togglePreAction,
  type ActionLock,
  type ArmedPreAction,
  type PreActionContext,
  type PreActionKind,
  type RaisePresetKey,
} from './actionLogic';
import {
  RAISE_CONTROLS_ID,
  createActionButton,
  createHead,
  createPreActionPanel,
  createRaiseDrawer,
  paintActionButton,
  setButtonIcon,
  type ActionButton,
  type BarHead,
  type PreActionPanel,
  type RaiseDrawer,
} from './actionBarParts';
import { clamp, computeTotalPot, el, setData, setDisabled, setHidden, setStyleProperty, setText } from './dom';

export * from './actionLogic';

const TICK_WINDOW_SECONDS = 10;
const URGENT_TICK_SECONDS = 3;
const FRAME_GRACE_MS = 1000;
const NON_TEXT_INPUT_TYPES = new Set(['radio', 'checkbox', 'range', 'button', 'submit']);
/** Short landscape screens lay the raise controls beside the buttons instead of folding them above. */
const COMPACT_LAYOUT_QUERY = '(max-height: 520px)';

type BarMode = 'turn' | 'wait' | 'status';
type RaiseSource = 'slider' | 'input' | 'preset' | 'step' | 'render';

interface Decision {
  key: string;
  legal: LegalActions;
  presets: Record<RaisePresetKey, number>;
  /** Slider granularity: one step is a small blind; the last position is always the all-in amount. */
  step: number;
  steps: number;
}

interface SettledPreAction {
  kind: PreActionKind;
  request: PlayerActionRequest;
}

function isTextEntry(target: HTMLElement): boolean {
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && !NON_TEXT_INPUT_TYPES.has(target.type);
}

function setAriaDisabled(node: HTMLElement, disabled: boolean): void {
  const value = String(disabled);
  if (node.getAttribute('aria-disabled') !== value) node.setAttribute('aria-disabled', value);
}

function preActionContextOf(state: TableView): PreActionContext {
  return { handNumber: state.handNumber, street: state.street, currentBet: state.currentBet };
}

/* ---------------------------------------------------------------- the bar */

export class ActionBar {
  /** Always in the DOM: it holds the live region, which must not sit inside the panel that hides between turns. */
  readonly element: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly head: BarHead;
  private readonly turnAnnouncement: HTMLElement;
  private readonly timer: HTMLElement;
  private readonly timerFill: HTMLElement;
  private readonly drawer: RaiseDrawer;
  private readonly preActions: PreActionPanel;
  private readonly buttonRow: HTMLElement;
  private readonly foldButton: ActionButton;
  private readonly callButton: ActionButton;
  private readonly raiseButton: ActionButton;
  private readonly allInButton: ActionButton;
  private readonly compactQuery: MediaQueryList | null;

  private state: TableView | null = null;
  private offsetMs = 0;
  private decision: Decision | null = null;
  private raiseAmount = 0;
  private drawerOpen = false;
  private armedPreAction: ArmedPreAction | null = null;
  private preActionNotice: { text: string; key: string } | null = null;
  private countdown: { deadline: number; durationMs: number } | null = null;
  private frameId: number | null = null;
  private lastTickSecond: number | null = null;
  private lock: ActionLock | null = null;
  private lockTimer: number | null = null;
  private expiredRenderKey: string | null = null;

  private readonly handleKeyDown = (event: KeyboardEvent): void => this.onKeyDown(event);
  private readonly handleLayoutChange = (): void => this.render();
  private readonly handleFrame = (): void => {
    this.frameId = null;
    if (this.countdown === null) return;
    const remaining = this.paintCountdown();
    if (remaining > -FRAME_GRACE_MS) this.frameId = window.requestAnimationFrame(this.handleFrame);
    // After rescheduling: the re-render below would otherwise start a second frame loop.
    this.refreshWhenDeadlinePasses(remaining);
  };

  constructor(
    private readonly onAction: (request: PlayerActionRequest) => void,
    private readonly audio: AudioManager,
  ) {
    this.head = createHead();
    this.turnAnnouncement = el('span', { className: 'visually-hidden', attrs: { 'aria-live': 'assertive', 'aria-atomic': 'true' } });
    this.timerFill = el('div', { className: 'action-bar__timer-fill' });
    this.timer = el('div', { className: 'action-bar__timer', dataset: { active: 'false' }, attrs: { 'aria-hidden': 'true' } }, this.timerFill);
    this.drawer = createRaiseDrawer();
    this.preActions = createPreActionPanel();

    this.foldButton = createActionButton('fold', 'F', 'fold', 'Desistir da mão (F)');
    this.callButton = createActionButton('call', 'C', 'check', 'Check ou pagar (C)');
    this.raiseButton = createActionButton('raise', 'R', 'raise', 'Apostar ou aumentar: R ajusta o valor, Enter confirma');
    this.allInButton = createActionButton('allin', 'A', 'allIn', 'Todas as fichas (A)');
    this.raiseButton.element.setAttribute('aria-controls', RAISE_CONTROLS_ID);
    this.buttonRow = el(
      'div',
      { className: 'action-bar__buttons' },
      this.foldButton.element,
      this.callButton.element,
      this.allInButton.element,
      this.raiseButton.element,
    );

    this.panel = el(
      'section',
      { className: 'action-bar', dataset: { turn: 'other', level: 'ok', mode: 'status', raise: 'closed' }, attrs: { 'aria-label': 'Suas ações', hidden: '' } },
      this.timer,
      this.head.element,
      this.preActions.element,
      this.drawer.panel,
      this.buttonRow,
    );
    this.element = el('div', { className: 'action-bar-host' }, this.panel, this.turnAnnouncement);

    this.compactQuery = typeof window.matchMedia === 'function' ? window.matchMedia(COMPACT_LAYOUT_QUERY) : null;
    this.bindEvents();
    window.addEventListener('keydown', this.handleKeyDown);
    this.compactQuery?.addEventListener('change', this.handleLayoutChange);
    this.render();
  }

  update(state: TableView, serverOffsetMs: number): void {
    this.state = state;
    this.offsetMs = serverOffsetMs;
    this.render();
  }

  setHandName(handName: string | null): void {
    setText(this.head.hand, handName ?? '');
    setHidden(this.head.hand, handName === null || handName === '');
  }

  /**
   * The server answered the player's own action with an error, so it never happened and another may be sent.
   * Only that error may call this: unrelated notices (a reconnect message, a failed join) must not unlock the bar.
   */
  handleActionError(): void {
    if (this.lock === null) return;
    this.clearLock();
    this.render();
  }

  dispose(): void {
    window.removeEventListener('keydown', this.handleKeyDown);
    this.compactQuery?.removeEventListener('change', this.handleLayoutChange);
    this.clearLockTimer();
    this.stopCountdown();
  }

  private bindEvents(): void {
    this.foldButton.element.addEventListener('click', () => this.submit({ type: 'fold' }));
    this.callButton.element.addEventListener('click', () => this.submitCallOrCheck());
    this.raiseButton.element.addEventListener('click', () => this.onRaiseButton());
    this.allInButton.element.addEventListener('click', () => this.submitAllIn());

    const { slider, amountInput, minusButton, plusButton, tokens } = this.drawer;
    slider.addEventListener('input', () => this.onSliderInput());
    amountInput.addEventListener('input', () => this.handleAmountTyping());
    amountInput.addEventListener('change', () => this.commitAmountInput());
    amountInput.addEventListener('blur', () => this.commitAmountInput());
    minusButton.addEventListener('click', () => this.stepAmount(-1));
    plusButton.addEventListener('click', () => this.stepAmount(1));
    for (const [key, token] of tokens) token.element.addEventListener('click', () => this.applyPreset(key));

    for (const [kind, button] of this.preActions.buttons) button.addEventListener('click', () => this.onPreActionToggle(kind));
  }

  /* ------------------------------------------------------------ rendering */

  private render(): void {
    const state = this.state;
    const seat = state !== null && state.self.seat !== null ? (state.seats[state.self.seat] ?? null) : null;
    const visible = state !== null && state.phase === 'running' && !state.self.isSpectator && seat !== null && seat.status !== 'busted';
    setHidden(this.panel, !visible);
    if (!visible) {
      this.resetWhenHidden();
      return;
    }

    const previousDecisionKey = this.decision?.key ?? null;
    this.decision = this.resolveDecision(state, seat);
    const decisionKey = this.decision?.key ?? null;
    const isNewDecision = decisionKey !== null && decisionKey !== previousDecisionKey;
    if (decisionKey !== previousDecisionKey) this.drawerOpen = false;
    // The lock outlives the round trip of the answer: it ends only together with the decision it was taken for.
    this.lock = reconcileActionLock(this.lock, decisionKey, Date.now());
    if (this.lock === null) this.clearLockTimer();

    const settled = this.settlePreAction(state, seat, isNewDecision);
    this.announceDecision(isNewDecision, settled);
    setData(this.panel, 'mode', this.resolveMode(state, seat));
    setData(this.panel, 'turn', this.decision === null ? 'other' : 'mine');
    // The countdown comes first: whether the buttons accept input depends on the deadline of this very decision.
    this.syncCountdown(state);
    this.renderStatus(state, seat);
    this.renderPreActions(state, seat);
    this.renderButtons();
    this.renderRaiseDrawer();
    if (settled !== null) this.submit(settled.request);
  }

  private resetWhenHidden(): void {
    this.decision = null;
    this.drawerOpen = false;
    this.armedPreAction = null;
    this.clearLock();
    setText(this.turnAnnouncement, '');
    this.stopCountdown();
  }

  private resolveMode(state: TableView, seat: SeatView): BarMode {
    if (this.decision !== null) return 'turn';
    return this.canArm(state, seat) ? 'wait' : 'status';
  }

  private canArm(state: TableView, seat: SeatView): boolean {
    return canArmPreAction({ street: state.street, status: seat.status, cardCount: seat.cardCount, hasDecision: this.decision !== null });
  }

  private resolveDecision(state: TableView, seat: SeatView): Decision | null {
    const legal = state.self.legal;
    if (legal === null || state.actingSeat !== seat.seat) return null;

    const key = buildDecisionKey(state.handNumber, state.street, state.turnDeadline, legal);
    const step = Math.max(1, state.config.smallBlind);
    const isNewDecision = this.decision?.key !== key;
    const presets = computeRaisePresets({
      legal,
      currentBet: state.currentBet,
      totalPot: computeTotalPot(state),
      bigBlind: state.config.bigBlind,
    });
    this.raiseAmount = isNewDecision ? legal.minRaiseTo : clampRaise(this.raiseAmount, legal);
    if (isNewDecision) this.drawer.amountInput.value = String(this.raiseAmount);

    return { key, legal, presets, step, steps: Math.max(0, Math.ceil((legal.maxRaiseTo - legal.minRaiseTo) / step)) };
  }

  /**
   * Runs the armed pre-action once, the moment the player's turn starts. Out of turn it only drops a choice that
   * no longer holds (new hand, new street, or a changed bet for "Check") and says why when that is not obvious.
   */
  private settlePreAction(state: TableView, seat: SeatView, isNewDecision: boolean): SettledPreAction | null {
    const armed = this.armedPreAction;
    const context = preActionContextOf(state);
    if (this.decision !== null) {
      if (!isNewDecision) return null;
      this.armedPreAction = null;
      this.preActionNotice = null;
      const request = takePreActionRequest(armed, context, this.decision.legal);
      return armed !== null && request !== null ? { kind: armed.kind, request } : null;
    }
    if (armed === null) return null;
    const reason = preActionClearReason(armed, context, this.canArm(state, seat));
    if (reason === null) return null;
    this.armedPreAction = null;
    const text = describePreActionClearReason(armed.kind, reason);
    this.preActionNotice = text === null ? null : { text, key: `${state.handNumber}:${state.street}` };
    return null;
  }

  /** render() runs after every update, so the chime and the announcement fire only when a decision first appears. */
  private announceDecision(isNewDecision: boolean, settled: SettledPreAction | null): void {
    const decision = this.decision;
    if (decision === null) {
      setText(this.turnAnnouncement, '');
      return;
    }
    if (!isNewDecision) return;
    if (settled !== null) {
      setText(this.turnAnnouncement, describePreActionResult(settled.kind, settled.request));
      return;
    }
    this.audio.play('yourTurn');
    setText(this.turnAnnouncement, describeTurn(decision.legal));
  }

  private remainingMs(): number | null {
    if (this.countdown === null) return null;
    return this.countdown.deadline - (Date.now() + this.offsetMs);
  }

  private isActionable(): boolean {
    return isDecisionActionable(this.decision?.key ?? null, this.lock?.key ?? null, this.remainingMs());
  }

  private isRaiseOpen(): boolean {
    const decision = this.decision;
    if (decision === null || !decision.legal.canRaise) return false;
    return this.drawerOpen || (this.compactQuery?.matches ?? false);
  }

  /** Buttons are re-rendered once when the countdown ends, so presses stop reaching a turn the server has closed. */
  private refreshWhenDeadlinePasses(remainingMs: number): void {
    const key = this.decision?.key ?? null;
    if (remainingMs > 0 || key === null || this.expiredRenderKey === key) return;
    this.expiredRenderKey = key;
    this.render();
  }

  private renderStatus(state: TableView, seat: SeatView): void {
    const actingName = state.actingSeat === null ? null : (state.seats[state.actingSeat]?.name ?? null);
    let text = 'Aguardando…';
    if (this.decision !== null) text = this.lock !== null ? 'Jogada enviada…' : 'Sua vez';
    else if (seat.status === 'sittingOut' || seat.status === 'waiting') text = 'Você entra na próxima mão';
    else if (seat.status === 'folded') text = 'Você desistiu desta mão';
    else if (seat.status === 'allIn') text = 'Você está all-in';
    else if (actingName !== null) text = `Aguardando ${actingName}…`;
    setText(this.head.status, text);
  }

  private renderPreActions(state: TableView, seat: SeatView): void {
    const armedKind = this.armedPreAction?.kind ?? null;
    for (const [kind, button] of this.preActions.buttons) {
      const pressed = String(kind === armedKind);
      if (button.getAttribute('aria-pressed') !== pressed) button.setAttribute('aria-pressed', pressed);
    }
    const shown = this.decision === null && this.canArm(state, seat);
    setHidden(this.preActions.element, !shown);
    if (!shown) return;

    const notice = this.preActionNotice !== null && this.preActionNotice.key === `${state.handNumber}:${state.street}` ? this.preActionNotice : null;
    setText(this.preActions.hint, armedKind === null && notice !== null ? notice.text : describePreAction(armedKind));
  }

  private renderButtons(): void {
    const decision = this.decision;
    const state = this.state;
    const stack = this.ownStack();
    setHidden(this.buttonRow, decision === null);
    if (decision === null || state === null || stack === null) return;

    const legal = decision.legal;
    const active = this.isActionable();
    const raiseControlsOpen = this.isRaiseOpen();
    const model = describeActionButtons({
      legal,
      stack,
      raiseAmount: this.raiseAmount,
      bigBlind: state.config.bigBlind,
      currentBet: state.currentBet,
      totalPot: computeTotalPot(state),
      raiseControlsOpen,
    });

    paintActionButton(this.foldButton, model.fold);
    setDisabled(this.foldButton.element, !(active && legal.canFold));

    paintActionButton(this.callButton, model.call);
    const isCall = legal.canCall && !legal.canCheck;
    setButtonIcon(this.callButton, isCall ? 'call' : 'check');
    setData(this.callButton.element, 'mode', isCall ? 'call' : 'check');
    setDisabled(this.callButton.element, !(active && (legal.canCheck || legal.canCall)));

    paintActionButton(this.raiseButton, model.raise);
    setData(this.raiseButton.element, 'kind', legal.isOpeningBet ? 'bet' : 'raise');
    setButtonIcon(this.raiseButton, raiseControlsOpen ? 'check' : 'raise');
    this.raiseButton.element.setAttribute('aria-expanded', String(raiseControlsOpen));
    setDisabled(this.raiseButton.element, !(active && legal.canRaise));

    paintActionButton(this.allInButton, model.allIn);
    setDisabled(this.allInButton.element, !(active && canGoAllIn(legal, stack)));
  }

  private renderRaiseDrawer(): void {
    const decision = this.decision;
    const { panel, inner, slider, amountInput, tokens, ticks, minusButton, plusButton } = this.drawer;
    const open = this.isRaiseOpen();
    setData(panel, 'open', open ? 'true' : 'false');
    setData(this.panel, 'raise', open ? 'open' : 'closed');
    if (inner.hasAttribute('inert') === open) inner.toggleAttribute('inert', !open);
    if (decision === null || !open) return;

    const maxPosition = String(decision.steps);
    if (slider.max !== maxPosition) slider.max = maxPosition;
    const locked = !this.isActionable();
    setDisabled(slider, decision.steps === 0 || locked);
    setDisabled(amountInput, locked);
    setDisabled(minusButton, locked);
    setDisabled(plusButton, locked);

    const fractions = presetTickFractions(decision.presets, decision.legal, decision.step, decision.steps);
    for (const key of RAISE_PRESET_KEYS) {
      const token = tokens.get(key);
      const tick = ticks.get(key);
      const label = presetLabel(key, decision.legal);
      const valueText = formatChips(decision.presets[key]);
      if (token) {
        setDisabled(token.element, locked);
        setText(token.name, label);
        setText(token.value, valueText);
        token.element.setAttribute('aria-label', `${label}: ${valueText} fichas`);
      }
      if (tick) setStyleProperty(tick, '--at', fractions[key].toFixed(4));
    }
    this.syncRaiseControls('render');
  }

  /** Reflects raiseAmount in the controls that were not the source of the change. */
  private syncRaiseControls(source: RaiseSource): void {
    const decision = this.decision;
    const state = this.state;
    if (decision === null || state === null) return;
    const { slider, amountInput, tokens, bigBlindReadout, shareReadout, minusButton, plusButton } = this.drawer;
    const { legal } = decision;

    const position = sliderPosition(this.raiseAmount, legal, decision.step, decision.steps);
    if (source !== 'slider' && slider.value !== String(position)) slider.value = String(position);
    const fill = decision.steps === 0 ? 100 : (position / decision.steps) * 100;
    setStyleProperty(slider, '--fill', `${fill.toFixed(2)}%`);
    slider.setAttribute('aria-valuetext', `${formatChips(this.raiseAmount)} fichas`);

    const isTyping = source === 'input' || document.activeElement === amountInput;
    if (!isTyping && amountInput.value !== String(this.raiseAmount)) amountInput.value = String(this.raiseAmount);

    const matching = presetsMatchingAmount(this.raiseAmount, decision.presets);
    for (const [key, token] of tokens) {
      const pressed = String(matching.includes(key));
      if (token.element.getAttribute('aria-pressed') !== pressed) token.element.setAttribute('aria-pressed', pressed);
    }

    const facts = describeRaiseAmount({
      legal,
      raiseAmount: this.raiseAmount,
      bigBlind: state.config.bigBlind,
      currentBet: state.currentBet,
      totalPot: computeTotalPot(state),
    });
    setText(bigBlindReadout, facts.bigBlinds ?? '');
    setText(shareReadout, facts.share ?? '');
    // Reaching a limit dims the button without disabling it, so a keyboard user does not lose the focus.
    setAriaDisabled(minusButton, this.raiseAmount <= legal.minRaiseTo);
    setAriaDisabled(plusButton, this.raiseAmount >= legal.maxRaiseTo);
    if (source !== 'render') this.renderButtons();
  }

  /* ------------------------------------------------------------ raise controls */

  private setRaiseAmount(amount: number, source: Exclude<RaiseSource, 'input' | 'render'>): void {
    const decision = this.decision;
    if (decision === null) return;
    this.raiseAmount = clampRaise(amount, decision.legal);
    this.drawer.amountInput.setAttribute('aria-invalid', 'false');
    this.syncRaiseControls(source);
  }

  private onSliderInput(): void {
    const decision = this.decision;
    if (decision === null) return;
    const position = Number.parseInt(this.drawer.slider.value, 10);
    this.setRaiseAmount(amountAtSliderPosition(position, decision.legal, decision.step), 'slider');
  }

  private applyPreset(key: RaisePresetKey): void {
    const decision = this.decision;
    if (decision === null || !this.isActionable()) return;
    this.audio.play('uiClick');
    this.setRaiseAmount(decision.presets[key], 'preset');
  }

  private stepAmount(direction: 1 | -1): void {
    const decision = this.decision;
    const state = this.state;
    if (decision === null || state === null || !this.isActionable()) return;
    this.audio.play('uiClick');
    this.setRaiseAmount(stepRaise(this.raiseAmount, direction, Math.max(1, state.config.bigBlind), decision.legal), 'step');
  }

  private handleAmountTyping(): void {
    const decision = this.decision;
    if (decision === null) return;
    const { amountInput } = this.drawer;
    const digits = amountInput.value.replace(/\D/g, '');
    if (digits !== amountInput.value) amountInput.value = digits;
    const typed = digits === '' ? decision.legal.minRaiseTo : Number.parseInt(digits, 10);
    this.raiseAmount = clampRaise(typed, decision.legal);
    const outOfRange = typed < decision.legal.minRaiseTo || typed > decision.legal.maxRaiseTo;
    amountInput.setAttribute('aria-invalid', String(outOfRange));
    this.syncRaiseControls('input');
  }

  private commitAmountInput(): void {
    if (this.decision === null) return;
    this.drawer.amountInput.value = String(this.raiseAmount);
    this.drawer.amountInput.setAttribute('aria-invalid', 'false');
  }

  /** First press opens the raise controls; once they are open the same button confirms what they show. */
  private onRaiseButton(): void {
    const decision = this.decision;
    if (decision === null || !decision.legal.canRaise || !this.isActionable()) return;
    if (this.isRaiseOpen()) this.submitRaise();
    else this.openRaiseControls(false);
  }

  private openRaiseControls(focusAmount: boolean): void {
    if (this.decision === null || !this.decision.legal.canRaise || !this.isActionable()) return;
    this.audio.play('uiClick');
    this.drawerOpen = true;
    this.render();
    if (!focusAmount) return;
    this.drawer.amountInput.focus();
    this.drawer.amountInput.select();
  }

  private closeRaiseControls(): void {
    if (!this.drawerOpen) return;
    this.drawerOpen = false;
    this.render();
  }

  /* ------------------------------------------------------------ answering */

  private onPreActionToggle(kind: PreActionKind): void {
    const state = this.state;
    if (state === null || this.decision !== null) return;
    this.audio.play('uiClick');
    this.preActionNotice = null;
    this.armedPreAction = togglePreAction(this.armedPreAction, kind, preActionContextOf(state));
    this.render();
  }

  private submitCallOrCheck(): void {
    const legal = this.decision?.legal;
    const request = legal ? resolveCallOrCheck(legal) : null;
    if (request !== null) this.submit(request);
  }

  private submitAllIn(): void {
    const legal = this.decision?.legal;
    const stack = this.ownStack();
    if (legal && stack !== null && canGoAllIn(legal, stack)) this.submit({ type: 'allIn' });
  }

  private submitRaise(): void {
    const legal = this.decision?.legal;
    const request = legal ? resolveRaiseRequest(legal, this.raiseAmount) : null;
    if (request !== null) this.submit(request);
  }

  private ownStack(): number | null {
    const state = this.state;
    if (state === null || state.self.seat === null) return null;
    return state.seats[state.self.seat]?.chips ?? null;
  }

  private submit(request: PlayerActionRequest): void {
    const decision = this.decision;
    if (decision === null || !this.isActionable()) return;
    if (request.type === 'fold' && !decision.legal.canFold) return;

    this.audio.play('uiClick');
    this.takeLock(decision.key);
    this.onAction(request);
    this.render();
  }

  private takeLock(decisionKey: string): void {
    const lock = takeActionLock(decisionKey, Date.now());
    this.lock = lock;
    this.clearLockTimer();
    // Safety net for a reply that never comes; the identity check keeps a newer lock from being released early.
    this.lockTimer = window.setTimeout(() => {
      this.lockTimer = null;
      if (this.lock !== lock) return;
      this.lock = null;
      this.render();
    }, ACTION_LOCK_TIMEOUT_MS);
  }

  private clearLock(): void {
    this.lock = null;
    this.clearLockTimer();
  }

  private clearLockTimer(): void {
    if (this.lockTimer !== null) window.clearTimeout(this.lockTimer);
    this.lockTimer = null;
  }

  /* ------------------------------------------------------------ keyboard */

  private onKeyDown(event: KeyboardEvent): void {
    if (this.decision === null || event.defaultPrevented || event.repeat) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target instanceof HTMLElement ? event.target : null;

    if (event.key === 'Enter') {
      this.onEnter(event, target);
      return;
    }
    if (event.key === 'Escape') {
      this.onEscape(event, target);
      return;
    }
    if (target !== null && isTextEntry(target)) return;

    const outcome = resolveShortcut(event.key, this.decision.legal, this.ownStack() ?? 0);
    if (outcome === null) return;
    event.preventDefault();
    if (outcome.kind === 'submit') this.submit(outcome.request);
    else this.openRaiseControls(true);
  }

  /** Enter confirms the raise while its controls are open, but never steals the native click of a focused button. */
  private onEnter(event: KeyboardEvent, target: HTMLElement | null): void {
    if (!this.isRaiseOpen()) return;
    const isPageLevel = target === null || target === document.body;
    const isInsideBar = target !== null && this.panel.contains(target);
    if (!isPageLevel && !isInsideBar) return;
    if (target?.closest('button')) return;
    event.preventDefault();
    this.submitRaise();
  }

  private onEscape(event: KeyboardEvent, target: HTMLElement | null): void {
    if (!this.drawerOpen) return;
    const isPageLevel = target === null || target === document.body;
    const isInsideBar = target !== null && this.panel.contains(target);
    if (!isPageLevel && !isInsideBar) return;
    event.preventDefault();
    if (target === this.drawer.amountInput) this.drawer.amountInput.blur();
    this.closeRaiseControls();
  }

  /* ------------------------------------------------------------ countdown */

  private syncCountdown(state: TableView): void {
    if (this.decision === null || state.turnDeadline === null) {
      this.stopCountdown();
      return;
    }
    if (this.countdown?.deadline !== state.turnDeadline) this.lastTickSecond = null;
    this.countdown = { deadline: state.turnDeadline, durationMs: Math.max(1, state.turnDurationMs) };
    setData(this.timer, 'active', 'true');
    this.paintCountdown();
    if (this.frameId === null) this.frameId = window.requestAnimationFrame(this.handleFrame);
  }

  private stopCountdown(): void {
    this.countdown = null;
    this.lastTickSecond = null;
    if (this.frameId !== null) window.cancelAnimationFrame(this.frameId);
    this.frameId = null;
    setData(this.timer, 'active', 'false');
    setData(this.panel, 'level', 'ok');
    setText(this.head.seconds, '');
  }

  /** Paints the bar and returns the remaining milliseconds. */
  private paintCountdown(): number {
    const countdown = this.countdown;
    if (countdown === null) return 0;

    const remaining = countdown.deadline - (Date.now() + this.offsetMs);
    const ratio = clamp(remaining / countdown.durationMs, 0, 1);
    this.timerFill.style.transform = `scaleX(${ratio.toFixed(4)})`;
    const seconds = Math.max(0, Math.ceil(remaining / 1000));
    setText(this.head.seconds, `${seconds}s`);
    setData(this.panel, 'level', countdownLevel(remaining));
    this.playTick(seconds);
    return remaining;
  }

  private playTick(seconds: number): void {
    if (seconds <= 0 || seconds > TICK_WINDOW_SECONDS || seconds === this.lastTickSecond) return;
    this.lastTickSecond = seconds;
    this.audio.play(seconds <= URGENT_TICK_SECONDS ? 'tickUrgent' : 'tick');
  }
}
