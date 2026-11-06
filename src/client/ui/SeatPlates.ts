import './seatPlates.css';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { formatChips } from '../../shared/format';
import { MAX_SEATS, type SeatView, type TableView } from '../../shared/protocol';
import { POT_POSITION, getSeatAnchor, slotForSeat } from '../scene/SeatLayout';
import type { Stage } from '../scene/Stage';
import { type ActionCallout, type CalloutAction, describeAction, formatLastAction, toneOfLastAction } from './actionCallout';
import { type ScreenBox, type ScreenOffset, boxAround, clearOfObstacles, translateBox } from './betLabelPlacement';
import { el, restartAnimation, safeColor, setData, setHidden, setText, svgEl, timerLevel } from './dom';
import { createActionIcon } from './hudIcons';

const RING_RADIUS = 25;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
/** Longer than the award animation, so the ribbon is still up while the chips reach the winner. */
const WIN_FLASH_MS = 4200;
const CALLOUT_MS = 2200;
const CALLOUT_LEAVE_MS = 220;
const TIMER_GRACE_MS = 1000;
/** Pot and bet labels are lifted slightly so they never sit inside the chip geometry. */
const POT_LABEL_FORWARD_OFFSET = 0.07;
const LABEL_LIFT = 0.03;
const BET_LABEL_PULL_BACK = 0.05;
/** Space kept between a bet pill and the plates or pills around it. */
const BET_LABEL_CLEARANCE_PX = 4;

const STATUS_BADGES: Partial<Record<string, string>> = {
  allIn: 'All-in',
  sittingOut: 'Ausente',
  busted: 'Sem fichas',
  waiting: 'Aguardando',
  offline: 'Offline',
};

interface PlateContext {
  isSelf: boolean;
  isDealer: boolean;
  isActing: boolean;
}

/** One player's name plate: a chip avatar with a timer ring, name, stack, and the callouts that float above it. */
class SeatPlate {
  readonly object: CSS2DObject;
  slot = -1;
  private readonly root: HTMLElement;
  private readonly main: HTMLElement;
  private readonly tags: HTMLElement;
  private readonly avatar: HTMLElement;
  private readonly ring: SVGCircleElement;
  private readonly dealerBadge: HTMLElement;
  private readonly nameText: HTMLElement;
  private readonly chipsText: HTMLElement;
  private readonly statusBadge: HTMLElement;
  private readonly actionPill: HTMLElement;
  private readonly thinking: HTMLElement;
  private readonly handLabel: HTMLElement;
  private readonly callout: HTMLElement;
  private readonly ribbon: HTMLElement;
  private readonly ribbonAmount: HTMLElement;
  private readonly ribbonHand: HTMLElement;
  private shownColor = '';
  private handText = '';
  private winTimer: number | null = null;
  private winTotal = 0;
  private calloutLeaveTimer: number | null = null;
  private calloutHideTimer: number | null = null;

  constructor() {
    this.ring = svgEl('circle', {
      class: 'seat-plate__ring-progress',
      cx: 30,
      cy: 30,
      r: RING_RADIUS,
      'stroke-dasharray': RING_CIRCUMFERENCE.toFixed(2),
      'stroke-dashoffset': RING_CIRCUMFERENCE.toFixed(2),
    });
    const ringSvg = svgEl(
      'svg',
      { class: 'seat-plate__ring', viewBox: '0 0 60 60', 'aria-hidden': 'true' },
      svgEl('circle', { class: 'seat-plate__ring-track', cx: 30, cy: 30, r: RING_RADIUS }),
      this.ring,
    );

    this.avatar = el('span', { className: 'seat-plate__avatar' });
    this.dealerBadge = el('span', { className: 'seat-plate__dealer', text: 'D', attrs: { title: 'Dealer', hidden: '' } });
    this.nameText = el('span', { className: 'seat-plate__name' });
    this.chipsText = el('span', { className: 'seat-plate__chips' });
    this.statusBadge = el('span', { className: 'seat-plate__badge', attrs: { hidden: '' } });
    this.actionPill = el('span', { className: 'seat-plate__action', attrs: { hidden: '' } });
    this.thinking = this.createThinkingTag();
    this.handLabel = el('span', { className: 'seat-plate__hand', attrs: { hidden: '' } });
    this.callout = el('span', { className: 'seat-callout', attrs: { hidden: '', 'aria-hidden': 'true' } });
    this.ribbonAmount = el('span', { className: 'seat-ribbon__amount' });
    this.ribbonHand = el('span', { className: 'seat-ribbon__hand', attrs: { hidden: '' } });
    this.ribbon = el(
      'span',
      { className: 'seat-ribbon', attrs: { hidden: '' } },
      el('span', { className: 'seat-ribbon__line' }, el('span', { className: 'seat-ribbon__title', text: 'Vencedor' }), this.ribbonAmount),
      this.ribbonHand,
    );

    this.main = el(
      'div',
      { className: 'seat-plate__main' },
      el('div', { className: 'seat-plate__avatar-wrap' }, ringSvg, this.avatar, this.dealerBadge),
      el('div', { className: 'seat-plate__info' }, this.nameText, this.chipsText),
    );
    this.tags = el('div', { className: 'seat-plate__tags' }, this.statusBadge, this.actionPill, this.thinking);
    this.root = el(
      'div',
      { className: 'seat-plate' },
      el('div', { className: 'seat-plate__above' }, this.ribbon, this.handLabel, this.callout),
      this.main,
      this.tags,
    );
    this.object = new CSS2DObject(el('div', { className: 'seat-anchor' }, this.root));
  }

  /** What bet pills must not cover: the plate itself and, while it shows something, the tag strip under it. */
  obstacleBoxes(): ScreenBox[] {
    const boxes = [this.main.getBoundingClientRect()];
    if (Array.from(this.tags.children).some((tag) => !(tag as HTMLElement).hidden)) boxes.push(this.tags.getBoundingClientRect());
    return boxes.map(({ left, top, right, bottom }) => ({ left, top, right, bottom }));
  }

  /** CSS keeps the side seats' tags and callouts on screen by aligning them to the screen edge. */
  setSlot(slot: number): void {
    this.slot = slot;
    setData(this.root, 'slot', String(slot));
  }

  apply(seat: SeatView, context: PlateContext): void {
    const color = safeColor(seat.color);
    if (color !== this.shownColor) {
      this.shownColor = color;
      this.root.style.setProperty('--player-color', color);
    }
    setText(this.nameText, seat.name);
    setText(this.chipsText, formatChips(seat.chips));
    setText(this.avatar, seat.avatar);

    const status = seat.connected ? seat.status : 'offline';
    setData(this.root, 'status', status);
    this.root.classList.toggle('is-acting', context.isActing);
    this.root.classList.toggle('is-self', context.isSelf);
    setHidden(this.dealerBadge, !context.isDealer);
    setHidden(this.thinking, !(seat.isBot && context.isActing));

    const badge = STATUS_BADGES[status] ?? '';
    setText(this.statusBadge, badge);
    setHidden(this.statusBadge, badge === '');

    const redundantAllIn = status === 'allIn' && seat.lastAction === 'All-In';
    const action = redundantAllIn ? null : seat.lastAction;
    setText(this.actionPill, action === null ? '' : formatLastAction(action));
    setHidden(this.actionPill, action === null);
    if (action !== null) setData(this.actionPill, 'tone', toneOfLastAction(action));
  }

  setHandLabel(text: string | null): void {
    this.handText = text ?? '';
    setText(this.handLabel, this.handText);
    setHidden(this.handLabel, this.handText === '');
    this.paintRibbonHand();
  }

  showCallout(callout: ActionCallout): void {
    this.cancelCalloutTimers();
    const content: Node[] = [createActionIcon(callout.tone), el('span', { className: 'seat-callout__verb', text: callout.verb })];
    if (callout.amount !== null) content.push(el('span', { className: 'seat-callout__amount', text: formatChips(callout.amount) }));
    this.callout.replaceChildren(...content);
    setData(this.callout, 'tone', callout.tone);
    this.callout.classList.remove('is-leaving');
    setHidden(this.callout, false);
    restartAnimation(this.callout, 'is-popping');
    this.calloutLeaveTimer = window.setTimeout(() => this.leaveCallout(), CALLOUT_MS);
  }

  clearCallout(): void {
    this.cancelCalloutTimers();
    this.callout.classList.remove('is-leaving', 'is-popping');
    setHidden(this.callout, true);
  }

  flashWin(amount: number): void {
    this.winTotal = this.winTimer === null ? amount : this.winTotal + amount;
    setText(this.ribbonAmount, `+${formatChips(this.winTotal)}`);
    this.paintRibbonHand();
    setHidden(this.ribbon, false);
    restartAnimation(this.ribbon, 'is-popping');
    // Restart the keyframes so back-to-back awards (main + side pot) both read as a pulse.
    restartAnimation(this.root, 'is-winner');
    if (this.winTimer !== null) window.clearTimeout(this.winTimer);
    this.winTimer = window.setTimeout(() => this.clearWin(), WIN_FLASH_MS);
  }

  clearWin(): void {
    if (this.winTimer !== null) window.clearTimeout(this.winTimer);
    this.winTimer = null;
    this.winTotal = 0;
    this.root.classList.remove('is-winner');
    this.ribbon.classList.remove('is-popping');
    setHidden(this.ribbon, true);
  }

  paintTimer(ratio: number, level: string): void {
    this.ring.style.strokeDashoffset = (RING_CIRCUMFERENCE * (1 - ratio)).toFixed(2);
    setData(this.root, 'level', level);
  }

  resetTimer(): void {
    this.ring.style.strokeDashoffset = RING_CIRCUMFERENCE.toFixed(2);
    setData(this.root, 'level', 'ok');
  }

  dispose(): void {
    this.clearWin();
    this.clearCallout();
  }

  private createThinkingTag(): HTMLElement {
    const dots = el('span', { className: 'seat-plate__dots' }, el('i'), el('i'), el('i'));
    return el('span', { className: 'seat-plate__thinking', attrs: { hidden: '', 'aria-hidden': 'true' } }, el('span', { text: 'pensando' }), dots);
  }

  private paintRibbonHand(): void {
    setText(this.ribbonHand, this.handText);
    setHidden(this.ribbonHand, this.handText === '');
  }

  private leaveCallout(): void {
    this.calloutLeaveTimer = null;
    this.callout.classList.add('is-leaving');
    this.calloutHideTimer = window.setTimeout(() => this.clearCallout(), CALLOUT_LEAVE_MS);
  }

  private cancelCalloutTimers(): void {
    if (this.calloutLeaveTimer !== null) window.clearTimeout(this.calloutLeaveTimer);
    if (this.calloutHideTimer !== null) window.clearTimeout(this.calloutHideTimer);
    this.calloutLeaveTimer = null;
    this.calloutHideTimer = null;
  }
}

interface FloatingLabel {
  object: CSS2DObject;
  /** The visible pill, which slides by `offset` (CSS left/top) to stay clear of plates. */
  pill: HTMLElement;
  text: HTMLElement;
  offset: ScreenOffset;
}

interface TimerState {
  seat: number;
  deadline: number;
  durationMs: number;
  offsetMs: number;
}

/** CSS2D labels floating over the 3D table: name plates, bet pills and the pot label. */
export class SeatPlates {
  private readonly plates = new Map<number, SeatPlate>();
  private readonly betLabels = new Map<number, FloatingLabel>();
  private potLabel: FloatingLabel | null = null;
  private viewerSeat: number | null = null;
  private lastHandNumber = -1;
  private timer: TimerState | null = null;
  private frameId: number | null = null;
  private readonly stopFrameCallback: () => void;

  private readonly handleFrame = (): void => {
    this.frameId = null;
    if (this.timer === null) return;
    const remaining = this.paintTimer(this.timer);
    if (remaining > -TIMER_GRACE_MS) this.frameId = window.requestAnimationFrame(this.handleFrame);
  };

  constructor(private readonly stage: Stage) {
    this.stopFrameCallback = stage.onFrame(() => this.clearBetLabelsOfPlates());
  }

  update(state: TableView, serverOffsetMs: number): void {
    const viewerChanged = this.viewerSeat !== state.self.seat;
    this.viewerSeat = state.self.seat;

    if (state.handNumber !== this.lastHandNumber) {
      this.lastHandNumber = state.handNumber;
      this.clearTransientLabels();
    }

    for (let seatIndex = 0; seatIndex < MAX_SEATS; seatIndex++) {
      const seat = state.seats[seatIndex] ?? null;
      if (seat === null) {
        this.removePlate(seatIndex);
        continue;
      }
      const plate = this.plates.get(seatIndex) ?? this.createPlate(seatIndex);
      this.placePlate(plate, seatIndex);
      plate.apply(seat, {
        isSelf: seatIndex === state.self.seat,
        isDealer: state.phase === 'running' && state.dealerSeat === seatIndex,
        isActing: state.actingSeat === seatIndex,
      });
    }

    if (viewerChanged) this.relayoutBetLabels();
    this.syncTimer(state, serverOffsetMs);
  }

  setHandLabel(seat: number, text: string | null): void {
    this.plates.get(seat)?.setHandLabel(text);
  }

  /** A colour-coded badge floats above the plate for a couple of seconds; a newer action replaces it. */
  showAction(seat: number, action: CalloutAction, amount: number, totalBet: number): void {
    this.plates.get(seat)?.showCallout(describeAction(action, amount, totalBet));
  }

  flashWin(seat: number, amount: number): void {
    this.plates.get(seat)?.flashWin(amount);
  }

  setBetLabel(seat: number, amount: number | null): void {
    if (amount === null || amount <= 0) {
      this.removeBetLabel(seat);
      return;
    }
    const label = this.betLabels.get(seat) ?? this.createBetLabel(seat);
    setText(label.text, formatChips(amount));
    this.placeBetLabel(label, seat);
  }

  setPotLabel(text: string | null): void {
    if (text === null || text === '') {
      if (this.potLabel) this.potLabel.object.visible = false;
      return;
    }
    if (this.potLabel === null) this.potLabel = this.createPotLabel();
    setText(this.potLabel.text, text);
    this.potLabel.object.visible = true;
  }

  dispose(): void {
    this.stopFrameCallback();
    this.stopTimer();
    for (const seat of [...this.plates.keys()]) this.removePlate(seat);
    for (const seat of [...this.betLabels.keys()]) this.removeBetLabel(seat);
    if (this.potLabel) this.stage.tableRoot.remove(this.potLabel.object);
    this.potLabel = null;
  }

  private createPlate(seat: number): SeatPlate {
    const plate = new SeatPlate();
    this.plates.set(seat, plate);
    this.stage.tableRoot.add(plate.object);
    return plate;
  }

  private placePlate(plate: SeatPlate, seat: number): void {
    const slot = slotForSeat(seat, this.viewerSeat);
    if (plate.slot === slot) return;
    plate.setSlot(slot);
    plate.object.position.copy(getSeatAnchor(slot).plate);
  }

  private removePlate(seat: number): void {
    const plate = this.plates.get(seat);
    if (!plate) return;
    plate.dispose();
    this.stage.tableRoot.remove(plate.object);
    this.plates.delete(seat);
  }

  /** A new hand wipes showdown hand names, win ribbons and action callouts left from the previous one. */
  private clearTransientLabels(): void {
    for (const plate of this.plates.values()) {
      plate.setHandLabel(null);
      plate.clearWin();
      plate.clearCallout();
    }
  }

  private createFloatingLabel(className: string): FloatingLabel {
    const text = el('span', { className: `${className}__text` });
    const pill = el('div', { className }, text);
    const object = new CSS2DObject(el('div', { className: 'floating-anchor' }, pill));
    this.stage.tableRoot.add(object);
    return { object, pill, text, offset: { x: 0, y: 0 } };
  }

  private createBetLabel(seat: number): FloatingLabel {
    const label = this.createFloatingLabel('bet-label');
    this.betLabels.set(seat, label);
    return label;
  }

  private createPotLabel(): FloatingLabel {
    const label = this.createFloatingLabel('pot-label');
    label.object.position.copy(POT_POSITION);
    // Sit just in front of the pot (toward the viewer) so the label never hides the chips themselves.
    label.object.position.z += POT_LABEL_FORWARD_OFFSET;
    label.object.position.y += LABEL_LIFT;
    return label;
  }

  private placeBetLabel(label: FloatingLabel, seat: number): void {
    const anchor = getSeatAnchor(slotForSeat(seat, this.viewerSeat));
    label.object.position.copy(anchor.bet).addScaledVector(anchor.inward, -BET_LABEL_PULL_BACK);
    label.object.position.y += LABEL_LIFT;
  }

  /**
   * Pills are projected from the felt but plates keep their pixel size, so on small screens a pill can land on a
   * plate. Every frame the pills slide just far enough to uncover the plates (and each other). All rectangles are
   * read before any style is written, so the frame costs a single layout.
   */
  private clearBetLabelsOfPlates(): void {
    if (this.betLabels.size === 0) return;
    const plateBoxes = [...this.plates.values()].flatMap((plate) => plate.obstacleBoxes());
    const pills = [...this.betLabels.entries()]
      .map(([seat, label]) => ({ label, slot: slotForSeat(seat, this.viewerSeat), base: this.measureUnshiftedPill(label) }))
      .sort((first, second) => first.slot - second.slot);

    const placedPills: ScreenBox[] = [];
    for (const { label, base } of pills) {
      if (base === null) continue;
      const offset = clearOfObstacles(base, [...plateBoxes, ...placedPills], BET_LABEL_CLEARANCE_PX);
      placedPills.push(translateBox(base, offset));
      this.moveBetLabel(label, offset);
    }
  }

  /** Where the pill would be without the slide, from layout sizes so the pop-in scale animation does not matter. */
  private measureUnshiftedPill(label: FloatingLabel): ScreenBox | null {
    const width = label.pill.offsetWidth;
    const height = label.pill.offsetHeight;
    if (width === 0 || height === 0) return null;
    const rect = label.pill.getBoundingClientRect();
    return boxAround(rect.left + rect.width / 2 - label.offset.x, rect.top + rect.height / 2 - label.offset.y, width, height);
  }

  private moveBetLabel(label: FloatingLabel, offset: ScreenOffset): void {
    const x = Math.round(offset.x);
    const y = Math.round(offset.y);
    if (x === label.offset.x && y === label.offset.y) return;
    label.offset = { x, y };
    label.pill.style.left = `${x}px`;
    label.pill.style.top = `${y}px`;
  }

  private relayoutBetLabels(): void {
    for (const [seat, label] of this.betLabels) this.placeBetLabel(label, seat);
  }

  private removeBetLabel(seat: number): void {
    const label = this.betLabels.get(seat);
    if (!label) return;
    this.stage.tableRoot.remove(label.object);
    this.betLabels.delete(seat);
  }

  private syncTimer(state: TableView, offsetMs: number): void {
    const acting = state.actingSeat;
    const isRunning = acting !== null && state.turnDeadline !== null && this.plates.has(acting);
    const previousSeat = this.timer?.seat ?? null;
    if (previousSeat !== null && (!isRunning || previousSeat !== acting)) this.plates.get(previousSeat)?.resetTimer();

    if (!isRunning || state.turnDeadline === null) {
      this.stopTimer();
      return;
    }
    this.timer = { seat: acting, deadline: state.turnDeadline, durationMs: Math.max(1, state.turnDurationMs), offsetMs };
    this.paintTimer(this.timer);
    if (this.frameId === null) this.frameId = window.requestAnimationFrame(this.handleFrame);
  }

  private stopTimer(): void {
    this.timer = null;
    if (this.frameId !== null) window.cancelAnimationFrame(this.frameId);
    this.frameId = null;
  }

  /** Paints the ring and returns the remaining milliseconds. */
  private paintTimer(timer: TimerState): number {
    const remaining = timer.deadline - (Date.now() + timer.offsetMs);
    const ratio = Math.min(1, Math.max(0, remaining / timer.durationMs));
    this.plates.get(timer.seat)?.paintTimer(ratio, timerLevel(remaining, timer.durationMs));
    return remaining;
  }
}
