import gsap from 'gsap';
import * as THREE from 'three';
import type { Card } from '../../shared/cards';
import { formatChips } from '../../shared/format';
import { describeStartingHand, evaluateHand } from '../../shared/handEvaluator';
import {
  MAX_SEATS,
  type AwardView,
  type GameEvent,
  type PotView,
  type SeatView,
  type TableView as TableState,
} from '../../shared/protocol';
import type { AudioManager, SoundName } from '../audio/AudioManager';
import type { SeatPlates } from '../ui/SeatPlates';
import { CARD_HEIGHT, type CardFactory, type CardObject } from './CardFactory';
import { breakdownChips, type ChipFactory, type ChipStack } from './ChipFactory';
import { DEAL_GESTURE_SECONDS, DEAL_PICKUP_FRACTION, DEAL_RELEASE_FRACTION, type Dealer, type DealerActivity } from './Dealer';
import { PlayerStacks, type StackPlacement } from './PlayerStacks';
import { playerStackChips } from './playerStackLayout';
import {
  COMMUNITY_POSITIONS,
  DECK_POSITION,
  FELT_Y,
  HERO_CARD_OFFSETS,
  HERO_CARD_TILT,
  HOLE_FAN_ANGLE,
  HOLE_FAN_OFFSET,
  MUCK_POSITION,
  POT_POSITION,
  RAIL_Y,
  SEAT_SLOTS,
  SIDE_POT_POSITIONS,
  getSeatAnchor,
  slotForSeat,
  type SeatAnchor,
} from './SeatLayout';
import type { Stage } from './Stage';
import { createBlindButton, createDealerButton } from './TableButtons';
import type { TableModelResult } from './TableModel';

export interface TableViewDeps {
  stage: Stage;
  table: TableModelResult;
  cards: CardFactory;
  chips: ChipFactory;
  audio: AudioManager;
  plates: SeatPlates;
  /** The 3D croupier: when present, cards leave his hand and he gestures along with the Judge. */
  dealer?: Dealer;
}

type Timeline = gsap.core.Timeline;
type EventOf<Kind extends GameEvent['kind']> = Extract<GameEvent, { kind: Kind }>;

const PUCK_ORDER = ['dealer', 'smallBlind', 'bigBlind'] as const;
type PuckKey = (typeof PUCK_ORDER)[number];
type PuckSeats = Record<PuckKey, number | null>;

export interface CardPose {
  position: THREE.Vector3;
  rotation: { x: number; y: number; z: number };
  scale: number;
  /** Held up in the viewer's hand rather than lying on the felt. */
  inHand?: boolean;
}

interface HandRecord {
  cards: CardObject[];
  faceUp: boolean;
}

interface RunningPlay {
  timeline: Timeline;
  finish: () => void;
}

interface SceneDescription {
  viewerSeat: number | null;
  pucks: PuckSeats;
  hands: Record<number, string[]>;
  bets: Record<number, number>;
  community: string[];
  pots: number[];
}

interface CardMoveOptions {
  at: number;
  duration: number;
  /** Extra height above the straight line, reached halfway through the move. */
  lift: number;
  spinTurns?: number;
  sound?: SoundName;
  pan?: number;
  /** Reduced motion only: keep the card invisible until it pops in at its destination. */
  fromHidden?: boolean;
}

interface StackMoveOptions {
  from: THREE.Vector3;
  at: number;
  duration: number;
  arcHeight: number;
  fromHidden?: boolean;
}

const FULL_TURN = Math.PI * 2;
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const UNKNOWN_CARD = '??';

const MIN_SPEED = 0.1;
// Keeps instantaneous timelines alive for one tick so their callbacks and onComplete always fire.
const MIN_TIMELINE_SECONDS = 0.05;
const FAST_FORWARD_SPEED = 1.5;
const REDUCED_MOTION_SECONDS = 0.15;
const FADE_SECONDS = 0.15;
const STEREO_HALF_WIDTH = 0.9;

const HOLE_CARDS_PER_PLAYER = 2;
const CARD_REST_Y = FELT_Y + 0.002;
const CARD_LAYER_GAP = 0.0016;
const REVEAL_RAISE = 0.003;
const HERO_CARD_SCALE = 1.35;
/** Brings the viewer's cards toward the camera, off their seat anchor, so they read like cards held in hand. */
const HERO_CARD_PULL = 0.03;
/** The padded rail overhangs the felt near the viewer, so the hand floats just above rail height to stay whole. */
const HERO_CARD_HEIGHT_ABOVE_RAIL = 0.07;
const HERO_RAIL_CLEARANCE = 0.008;
const DECK_CARD_COUNT = 10;
const DECK_CARD_PITCH = 0.0014;
const DECK_TOP_Y = CARD_REST_Y + DECK_CARD_COUNT * DECK_CARD_PITCH;

const BIG_BET_CHIP_COUNT = 6;
const MAX_CLINK_COUNT = 3;
const PUCK_REST_GAP = 0.0005;
const SHARE_SPREAD = 0.05;

const CAMERA_RESET_SECONDS = 0.6;
const ZOOM_SECONDS = 1.1;
const SWEEP_FLIGHT_SECONDS = 0.35;
const SWEEP_STAGGER_SECONDS = 0.015;
const PUCK_SLIDE_SECONDS = 0.55;
const PUCK_DROP_SECONDS = 0.45;
const SHUFFLE_WIGGLE_SECONDS = 0.09;
const DEAL_STAGGER_SECONDS = 0.15;
// The dealer needs a little longer between cards for each pitch to read as a separate throw.
const DEALER_DEAL_STAGGER_SECONDS = 0.2;
const DEALER_COMMUNITY_STAGGER_SECONDS = 0.24;
const DEALER_CARD_LIFT = 0.07;
const COLLECT_GESTURE_SECONDS = 0.95;
const PUSH_GESTURE_SECONDS = 0.95;
const MIN_GESTURE_SECONDS = 0.12;
const DEAL_FLIGHT_SECONDS = 0.4;
const PEEK_SECONDS = 0.5;
const PEEK_STAGGER_SECONDS = 0.1;
const BET_FLIGHT_SECONDS = 0.45;
const CHECK_HOP_SECONDS = 0.1;
const FOLD_FLIGHT_SECONDS = 0.35;
const COLLECT_SLIDE_DELAY_SECONDS = 0.1;
const COLLECT_SLIDE_SECONDS = 0.5;
const REFUND_FLIGHT_SECONDS = 0.5;
const POT_SPLIT_SECONDS = 0.3;
const COMMUNITY_SLIDE_SECONDS = 0.38;
const COMMUNITY_SLIDE_STAGGER_SECONDS = 0.14;
const COMMUNITY_FLIP_SECONDS = 0.42;
const RIVER_FLIP_SECONDS = 0.8;
const COMMUNITY_FLIP_STAGGER_SECONDS = 0.22;
const REVEAL_FLIP_SECONDS = 0.5;
const REVEAL_STAGGER_SECONDS = 0.12;
const AWARD_LIFT_DELAY_SECONDS = 0.25;
const AWARD_TO_BET_SECONDS = 0.5;
const AWARD_TO_STACK_SECONDS = 0.45;
const AWARD_PAUSE_SECONDS = 0.1;
const AWARD_SHARE_STAGGER_SECONDS = 0.08;
const AWARD_POT_STAGGER_SECONDS = 0.4;

function panFor(position: THREE.Vector3): number {
  return Math.max(-1, Math.min(1, position.x / STEREO_HALF_WIDTH));
}

function restHeightOf(mesh: THREE.Mesh): number {
  return -new THREE.Box3().setFromObject(mesh).min.y;
}

function heightOf(mesh: THREE.Mesh): number {
  const bounds = new THREE.Box3().setFromObject(mesh);
  return bounds.max.y - bounds.min.y;
}

function applyPose(card: CardObject, pose: CardPose): void {
  card.position.copy(pose.position);
  card.rotation.set(pose.rotation.x, pose.rotation.y, pose.rotation.z);
  card.scale.setScalar(pose.scale);
  card.setInHand(pose.inHand === true);
}

function lateralOffset(anchor: SeatAnchor, distance: number): THREE.Vector3 {
  return new THREE.Vector3(distance, 0, 0).applyAxisAngle(Y_AXIS, anchor.yaw);
}

/** A hole card lying on the felt at its seat. Exported for the layout checks. */
export function tableCardPose(anchor: SeatAnchor, cardIndex: number, faceUp: boolean): CardPose {
  const side = cardIndex === 0 ? -1 : 1;
  const position = anchor.cards.clone().add(lateralOffset(anchor, side * HOLE_FAN_OFFSET));
  position.y = CARD_REST_Y + cardIndex * CARD_LAYER_GAP + (faceUp ? REVEAL_RAISE : 0);
  return {
    position,
    rotation: { x: 0, y: anchor.yaw - side * HOLE_FAN_ANGLE, z: faceUp ? 0 : Math.PI },
    scale: 1,
  };
}

/** One of the viewer's own cards, lifted and tilted toward the camera. Exported for the layout checks. */
export function heroCardPose(anchor: SeatAnchor, cardIndex: number): CardPose {
  const position = anchor.cards
    .clone()
    .addScaledVector(anchor.inward, -HERO_CARD_PULL)
    .add(lateralOffset(anchor, HERO_CARD_OFFSETS[cardIndex]));
  // The tilt drops the near edge below the card centre; keep that edge above the rail so nothing clips the hand.
  const nearEdgeDrop = ((CARD_HEIGHT * HERO_CARD_SCALE) / 2) * Math.sin(HERO_CARD_TILT);
  position.y = RAIL_Y + Math.max(HERO_CARD_HEIGHT_ABOVE_RAIL, nearEdgeDrop + HERO_RAIL_CLEARANCE);
  return { position, rotation: { x: HERO_CARD_TILT, y: anchor.yaw, z: 0 }, scale: HERO_CARD_SCALE, inHand: true };
}

function communityCardPose(slotIndex: number, faceUp: boolean): CardPose {
  const slot = COMMUNITY_POSITIONS[Math.min(slotIndex, COMMUNITY_POSITIONS.length - 1)];
  return {
    position: new THREE.Vector3(slot.x, CARD_REST_Y, slot.z),
    rotation: { x: 0, y: 0, z: faceUp ? 0 : Math.PI },
    scale: 1,
  };
}

function muckCardPose(order: number): CardPose {
  return {
    position: new THREE.Vector3(MUCK_POSITION.x, CARD_REST_Y + (order % 16) * CARD_LAYER_GAP, MUCK_POSITION.z),
    rotation: { x: 0, y: Math.sin(order * 2.4) * 0.45, z: Math.PI },
    scale: 1,
  };
}

function deckTopPosition(layer: number): THREE.Vector3 {
  return new THREE.Vector3(DECK_POSITION.x, DECK_TOP_Y + layer * 0.0004, DECK_POSITION.z);
}

/** Main pot sits at index 0; side pots take the contracted side positions (the last one is reused if there are more). */
function potPosition(index: number): THREE.Vector3 {
  if (index === 0) return new THREE.Vector3(POT_POSITION.x, FELT_Y, POT_POSITION.z);
  const side = SIDE_POT_POSITIONS[Math.min(index - 1, SIDE_POT_POSITIONS.length - 1)];
  return new THREE.Vector3(side.x, FELT_Y, side.z);
}

function quadraticBezier(
  start: THREE.Vector3,
  control: THREE.Vector3,
  end: THREE.Vector3,
  progress: number,
  out: THREE.Vector3,
): void {
  const inverse = 1 - progress;
  out.set(
    inverse * inverse * start.x + 2 * inverse * progress * control.x + progress * progress * end.x,
    inverse * inverse * start.y + 2 * inverse * progress * control.y + progress * progress * end.y,
    inverse * inverse * start.z + 2 * inverse * progress * control.z + progress * progress * end.z,
  );
}

function addArc(
  timeline: Timeline,
  target: THREE.Vector3,
  from: THREE.Vector3,
  to: THREE.Vector3,
  arcHeight: number,
  duration: number,
  at: number,
): void {
  const start = from.clone();
  const end = to.clone();
  // A quadratic bezier peaks at half of its control point's lift.
  const control = start.clone().lerp(end, 0.5);
  control.y += arcHeight * 2;
  const progress = { value: 0 };
  timeline.to(
    progress,
    {
      value: 1,
      duration,
      ease: 'power2.inOut',
      onUpdate: () => quadraticBezier(start, control, end, progress.value, target),
    },
    at,
  );
}

/** Chips the seat owns in a state; an empty seat owns none. */
function chipsOf(state: TableState, seat: number): number {
  return state.seats[seat]?.chips ?? 0;
}

function heldCardCount(view: SeatView): number {
  if (view.status === 'folded') return 0;
  return Math.max(view.cardCount, view.cards?.length ?? 0);
}

function describeState(state: TableState, viewerSeat: number | null): SceneDescription {
  const hands: Record<number, string[]> = {};
  const bets: Record<number, number> = {};
  for (const view of state.seats) {
    if (!view) continue;
    const count = heldCardCount(view);
    if (count > 0) {
      hands[view.seat] = Array.from({ length: count }, (_, index) => view.cards?.[index] ?? UNKNOWN_CARD);
    }
    if (view.bet > 0) bets[view.seat] = view.bet;
  }
  return {
    viewerSeat,
    pucks: { dealer: state.dealerSeat, smallBlind: state.smallBlindSeat, bigBlind: state.bigBlindSeat },
    hands,
    bets,
    community: [...state.community],
    pots: state.pots.filter((pot) => pot.amount > 0).map((pot) => pot.amount),
  };
}

/** Mirrors the server's wording: made hand once the flop is out, starting-hand class before that. */
function describeRevealedHand(cards: readonly Card[], board: readonly Card[]): string | null {
  if (cards.length !== HOLE_CARDS_PER_PLAYER) return null;
  return board.length >= 3 ? evaluateHand([...cards, ...board]).name : describeStartingHand(cards);
}

/** Busier in the lobby (nobody seated yet) and the waiting room, discreet while a hand is being played. */
function dealerActivityFor(state: TableState): DealerActivity {
  if (state.phase === 'running') return 'hand';
  return state.self.seat === null ? 'lobby' : 'waiting';
}

function formatPotLabel(total: number, potCount: number): string {
  const label = `Pote ${formatChips(total)}`;
  return potCount > 1 ? `${label} · ${potCount} potes` : label;
}

/** The visible dealer: owns every per-hand 3D object and plays the GSAP timeline of each game event. */
export class TableView {
  private readonly stage: Stage;
  private readonly cardFactory: CardFactory;
  private readonly chipFactory: ChipFactory;
  private readonly audio: AudioManager;
  private readonly plates: SeatPlates;
  private readonly dealer: Dealer | null;

  private readonly root = new THREE.Group();
  private readonly deck = new THREE.Group();
  private readonly pucks: Record<PuckKey, THREE.Mesh>;
  private readonly puckRestHeights: Record<PuckKey, number>;
  private readonly puckHeights: Record<PuckKey, number>;
  /** What each player owns, stacked on the felt in front of them; amounts follow SeatView.chips. */
  private readonly playerStacks: PlayerStacks;
  private puckSeats: PuckSeats = { dealer: null, smallBlind: null, bigBlind: null };

  private readonly hands = new Map<number, HandRecord>();
  private readonly betStacks = new Map<number, ChipStack>();
  private communityCards: CardObject[] = [];
  private potStacks: ChipStack[] = [];

  private readonly running = new Set<RunningPlay>();
  /** Objects owned by a running timeline; flushed if that timeline is killed before disposing them. */
  private readonly retiring = new Set<CardObject | ChipStack>();

  private viewerSeat: number | null = null;
  private sceneHandNumber: number | null = null;
  private reducedMotion = false;
  /** Speed of the timeline being built: dealer gestures run on real time, so their length is divided by it. */
  private playbackSpeed = 1;

  constructor(deps: TableViewDeps) {
    this.stage = deps.stage;
    this.cardFactory = deps.cards;
    this.chipFactory = deps.chips;
    this.audio = deps.audio;
    this.plates = deps.plates;
    this.dealer = deps.dealer ?? null;

    this.pucks = {
      dealer: createDealerButton(),
      smallBlind: createBlindButton('SB'),
      bigBlind: createBlindButton('BB'),
    };
    this.puckRestHeights = {
      dealer: restHeightOf(this.pucks.dealer),
      smallBlind: restHeightOf(this.pucks.smallBlind),
      bigBlind: restHeightOf(this.pucks.bigBlind),
    };
    this.puckHeights = {
      dealer: heightOf(this.pucks.dealer),
      smallBlind: heightOf(this.pucks.smallBlind),
      bigBlind: heightOf(this.pucks.bigBlind),
    };
    for (const key of PUCK_ORDER) {
      this.pucks[key].visible = false;
      this.root.add(this.pucks[key]);
    }

    this.root.name = 'table-view';
    this.buildDeck();
    this.root.add(this.deck);
    this.playerStacks = new PlayerStacks(this.chipFactory, MAX_SEATS);
    this.root.add(this.playerStacks.root);
    this.stage.tableRoot.add(this.root);
    // While he holds the deck (dealing, shuffling) the one on the felt would be a second copy.
    this.dealer?.onDeckHeldChange((held) => {
      this.deck.visible = !held;
    });
  }

  /** Rebuilds the whole scene from the state alone, so any desync heals itself. */
  sync(state: TableState, viewerSeat: number | null): void {
    this.abortRunning();
    this.clearScene();
    this.dealer?.lookAt(null);
    this.viewerSeat = viewerSeat;
    this.sceneHandNumber = state.handNumber;
    this.updateDealerContext(state);

    this.placePucksInstantly({
      dealer: state.dealerSeat,
      smallBlind: state.smallBlindSeat,
      bigBlind: state.bigBlindSeat,
    });
    state.community.forEach((code, index) => {
      const card = this.createCard(code);
      applyPose(card, communityCardPose(index, true));
      this.communityCards.push(card);
    });
    for (const view of state.seats) {
      if (view) this.restoreSeat(view);
    }
    state.pots
      .filter((pot) => pot.amount > 0)
      .forEach((pot, index) => {
        const stack = this.createStackAt(potPosition(index), pot.amount);
        this.potStacks.push(stack);
      });
    this.reconcilePlayerStacks(state);

    this.clearHandLabels();
    this.restoreHandLabels(state, viewerSeat);
    this.refreshLabels();
  }

  /**
   * Plays one event on top of the current scene; resolves when its timeline completes.
   * Failures (e.g. a malformed seat index) always surface as a rejection, never as a synchronous throw.
   */
  play(event: GameEvent, previous: TableState, next: TableState, speed: number): Promise<void> {
    try {
      this.ensureSceneMatches(event, previous, next);
      this.updateDealerContext(next);
      return this.dispatchEvent(event, next, speed);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  private dispatchEvent(event: GameEvent, next: TableState, speed: number): Promise<void> {
    switch (event.kind) {
      case 'handStart':
        return this.playHandStart(event, speed);
      case 'blind':
        return this.playBlind(event, next, speed);
      case 'dealHole':
        return this.playDealHole(event, next, speed);
      case 'turn':
        return this.playTurn(event, next, speed);
      case 'action':
        return this.playAction(event, next, speed);
      case 'collect':
        return this.playCollect(event, next, speed);
      case 'community':
        return this.playCommunity(event, next, speed);
      case 'reveal':
        return this.playReveal(event, speed);
      case 'award':
        return this.playAward(event, next, speed);
      case 'snapshot':
        this.sync(next, next.self.seat);
        return Promise.resolve();
      case 'playerJoined':
        this.welcomePlayer(event.seat, next);
        return this.settleWithoutAnimation(next);
      case 'handEnd':
      case 'rebuy':
      case 'playerLeft':
      case 'info':
        return this.settleWithoutAnimation(next);
    }
  }

  private playHandStart(event: EventOf<'handStart'>, speed: number): Promise<void> {
    this.sceneHandNumber = event.handNumber;
    this.stage.resetCamera(CAMERA_RESET_SECONDS / speed);
    this.dealer?.lookAt(null);
    return this.runTimeline(speed, (timeline) => {
      timeline.call(
        () => {
          this.clearHandLabels();
          this.refreshLabels();
        },
        undefined,
        0,
      );
      this.sweepLeftovers(timeline);
      this.shuffleDeck(timeline);
      this.slidePucks(
        timeline,
        { dealer: event.dealerSeat, smallBlind: event.smallBlindSeat, bigBlind: event.bigBlindSeat },
        this.step(0.1),
      );
    });
  }

  private playBlind(event: EventOf<'blind'>, next: TableState, speed: number): Promise<void> {
    this.plates.showAction(event.seat, event.blind === 'small' ? 'smallBlind' : 'bigBlind', event.amount, event.amount);
    return this.runTimeline(speed, (timeline) => {
      this.addChipsToBet(timeline, event.seat, event.amount, event.amount, chipsOf(next, event.seat));
      this.settlePlayerStacksAtEnd(timeline, next);
    });
  }

  private playDealHole(event: EventOf<'dealHole'>, next: TableState, speed: number): Promise<void> {
    return this.runTimeline(speed, (timeline) => {
      const flight = this.span(DEAL_FLIGHT_SECONDS);
      const stagger = this.step(this.usesDealerHand() ? DEALER_DEAL_STAGGER_SECONDS : DEAL_STAGGER_SECONDS);
      const lastLanding = new Map<number, number>();

      for (const seat of event.seats) {
        this.discardHand(seat);
        this.hands.set(seat, { cards: [], faceUp: false });
      }

      for (let round = 0; round < HOLE_CARDS_PER_PLAYER; round++) {
        event.seats.forEach((seat, order) => {
          const at = (round * event.seats.length + order) * stagger;
          const known = next.seats[seat]?.cards?.[round] ?? null;
          const card = this.spawnAtDeck(known, round * event.seats.length + order);
          const pose = this.holePose(seat, round, false);
          const pan = panFor(pose.position);
          this.hands.get(seat)?.cards.push(card);

          const launchAt = this.pitchCardTo(timeline, card, pose.position, at);
          this.moveCard(timeline, card, pose, {
            at: launchAt,
            duration: flight,
            lift: this.usesDealerHand() ? DEALER_CARD_LIFT : 0.12,
            spinTurns: 1 + (round % 2),
            pan,
            fromHidden: true,
          });
          timeline.call(() => this.audio.play('cardSlide', { pan }), undefined, launchAt);
          timeline.call(() => this.audio.play('cardSnap', { pan }), undefined, launchAt + flight * 0.92);
          lastLanding.set(seat, launchAt + flight);
        });
      }

      this.peekAtOwnCards(timeline, lastLanding);
      this.returnDealerGazeToTable(timeline, Math.max(0, ...lastLanding.values()));
    });
  }

  private playTurn(event: EventOf<'turn'>, next: TableState, speed: number): Promise<void> {
    this.directDealerAttention(event.seat, next);
    const hand = this.hands.get(event.seat);
    if (!hand || this.reducedMotion) return Promise.resolve();
    return this.runTimeline(speed, (timeline) => this.pulseCards(timeline, hand.cards, 0));
  }

  private playAction(event: EventOf<'action'>, next: TableState, speed: number): Promise<void> {
    this.plates.showAction(event.seat, event.action, event.amount, event.totalBet);
    switch (event.action) {
      case 'fold':
        return this.playFold(event.seat, speed);
      case 'check':
        return this.playCheck(event.seat, speed);
      case 'call':
      case 'bet':
      case 'raise':
      case 'allIn':
        return this.playChipAction(event, next, speed);
    }
  }

  private playFold(seat: number, speed: number): Promise<void> {
    const pan = panFor(this.anchorFor(seat).cards);
    return this.runTimeline(speed, (timeline) => {
      timeline.call(() => this.audio.play('fold', { pan }), undefined, 0);
      this.sendHandToMuck(timeline, seat, 0);
    });
  }

  private playCheck(seat: number, speed: number): Promise<void> {
    const pan = panFor(this.anchorFor(seat).cards);
    const hand = this.hands.get(seat);
    this.dealer?.nod();
    return this.runTimeline(speed, (timeline) => {
      timeline.call(() => this.audio.play('knock', { pan }), undefined, 0);
      if (!hand || this.reducedMotion) return;
      for (const card of hand.cards) {
        timeline.to(
          card.position,
          { y: card.position.y + 0.012, duration: CHECK_HOP_SECONDS, ease: 'power1.out', yoyo: true, repeat: 1 },
          0,
        );
      }
    });
  }

  private playChipAction(event: EventOf<'action'>, next: TableState, speed: number): Promise<void> {
    if (event.action === 'allIn') {
      this.audio.play('allIn');
      this.emphasize(this.betSpot(event.seat), speed);
    }
    return this.runTimeline(speed, (timeline) => {
      const alreadyIn = this.betStacks.get(event.seat)?.amount ?? 0;
      const moved = event.totalBet > alreadyIn ? event.totalBet - alreadyIn : event.amount;
      this.addChipsToBet(timeline, event.seat, moved, event.totalBet, chipsOf(next, event.seat));
      this.settlePlayerStacksAtEnd(timeline, next);
    });
  }

  private playCollect(event: EventOf<'collect'>, next: TableState, speed: number): Promise<void> {
    return this.runTimeline(speed, (timeline) => {
      const refunds = new Map(event.returned.map((entry) => [entry.seat, entry.amount] as const));
      const slideStart = this.step(COLLECT_SLIDE_DELAY_SECONDS);
      const slideDuration = this.span(COLLECT_SLIDE_SECONDS);

      for (const [seat, stack] of this.betStacks) {
        const refund = Math.min(refunds.get(seat) ?? 0, stack.amount);
        const potShare = stack.amount - refund;
        if (refund > 0) {
          const refundStack = potShare > 0 ? this.createStackAt(stack.position, refund) : stack;
          this.returnToPlayerStack(timeline, refundStack, seat, slideStart, chipsOf(next, seat));
        }
        if (potShare > 0) {
          if (refund > 0) stack.setAmount(potShare);
          this.sendToPot(timeline, stack, slideStart, slideDuration);
        }
      }
      this.betStacks.clear();

      timeline.call(() => this.refreshLabels(), undefined, 0);
      timeline.call(() => this.audio.play('chipsSlide'), undefined, slideStart);
      this.gestureOnTimeline(timeline, slideStart, (dealer, seconds) => dealer.gestureCollect(seconds), COLLECT_GESTURE_SECONDS);
      this.mergePots(timeline, event.pots, slideStart + slideDuration);
      this.settlePlayerStacksAtEnd(timeline, next);
    });
  }

  private playCommunity(event: EventOf<'community'>, next: TableState, speed: number): Promise<void> {
    const firstSlot = Math.max(0, next.community.length - event.cards.length);
    this.restoreMissingCommunity(next.community, firstSlot);
    return this.runTimeline(speed, (timeline) => {
      const slide = this.span(COMMUNITY_SLIDE_SECONDS);
      const slideStagger = this.step(this.usesDealerHand() ? DEALER_COMMUNITY_STAGGER_SECONDS : COMMUNITY_SLIDE_STAGGER_SECONDS);
      const flip = this.span(event.street === 'river' ? RIVER_FLIP_SECONDS : COMMUNITY_FLIP_SECONDS);
      const flipStagger = this.step(COMMUNITY_FLIP_STAGGER_SECONDS);
      const releaseDelay = this.usesDealerHand() ? DEAL_GESTURE_SECONDS * DEAL_RELEASE_FRACTION : 0;
      const flipsStart = (event.cards.length - 1) * slideStagger + releaseDelay + slide + this.step(0.06);

      event.cards.forEach((code, index) => {
        const slot = firstSlot + index;
        const pan = panFor(communityCardPose(slot, true).position);
        const stale = this.communityCards[slot];
        if (stale) this.disposeProp(stale);

        const card = this.spawnAtDeck(code, index);
        this.communityCards[slot] = card;
        const launchAt = this.pitchCardTo(timeline, card, communityCardPose(slot, false).position, index * slideStagger);
        this.moveCard(timeline, card, communityCardPose(slot, false), {
          at: launchAt,
          duration: slide,
          lift: this.usesDealerHand() ? DEALER_CARD_LIFT : 0.09,
          fromHidden: true,
        });
        timeline.call(() => this.audio.play('cardSlide', { pan }), undefined, launchAt);
        timeline.call(() => this.audio.play('cardSnap', { pan }), undefined, launchAt + slide * 0.92);
        this.moveCard(timeline, card, communityCardPose(slot, true), {
          at: flipsStart + index * flipStagger,
          duration: flip,
          lift: 0.07,
          sound: 'cardFlip',
          pan,
        });
      });

      // After an all-in the hands are already face-up, so every new street changes the best hand of each player.
      const lastFlipEnd = flipsStart + (event.cards.length - 1) * flipStagger + flip;
      timeline.call(() => this.restoreHandLabels(next, next.self.seat), undefined, lastFlipEnd);
      this.returnDealerGazeToTable(timeline, lastFlipEnd);
    });
  }

  private playReveal(event: EventOf<'reveal'>, speed: number): Promise<void> {
    if (event.allIn) this.emphasize(POT_POSITION, speed);
    return this.runTimeline(speed, (timeline) => {
      const flip = this.span(REVEAL_FLIP_SECONDS);
      event.hands.forEach((entry, order) => {
        const hand = this.ensureHand(entry.seat, entry.cards.length);
        const at = order * this.step(REVEAL_STAGGER_SECONDS);
        if (!hand.faceUp) {
          hand.faceUp = true;
          hand.cards.forEach((card, index) => {
            const code = entry.cards[index];
            if (code === undefined) return;
            card.setFace(code);
            this.moveCard(timeline, card, this.holePose(entry.seat, index, true), {
              at: at + index * this.step(0.08),
              duration: flip,
              lift: 0.03,
              sound: 'cardFlip',
              pan: panFor(card.position),
            });
          });
        }
        timeline.call(() => this.plates.setHandLabel(entry.seat, entry.handName), undefined, at + flip);
      });
    });
  }

  private playAward(event: EventOf<'award'>, next: TableState, speed: number): Promise<void> {
    this.highlightWinningCards(event);
    const sources = this.potStacks;
    this.potStacks = [];
    return this.runTimeline(speed, (timeline) => {
      timeline.call(
        () => {
          this.refreshLabels();
          if (event.showdown) this.labelWinningHands(event);
        },
        undefined,
        0,
      );

      const firstWinner = event.awards[0]?.winners[0];
      if (firstWinner) {
        const winnerSpot = this.betSpot(firstWinner.seat);
        this.gestureOnTimeline(
          timeline,
          this.step(AWARD_LIFT_DELAY_SECONDS) * 0.5,
          (dealer, seconds) => {
            dealer.lookAt(this.anchorFor(firstWinner.seat).plate);
            return dealer.gesturePush(winnerSpot, seconds);
          },
          PUSH_GESTURE_SECONDS,
        );
      }

      const spent = new Set<ChipStack>();
      const arrivals: number[] = [];
      event.awards.forEach((award, order) => {
        const source = sources[award.potIndex] ?? this.createStackAt(potPosition(award.potIndex), award.amount);
        spent.add(source);
        const at = order * this.step(AWARD_POT_STAGGER_SECONDS);
        arrivals.push(...this.payWinners(timeline, award, source, at));
      });
      for (const leftover of sources.filter((stack) => !spent.has(stack))) {
        this.fadeOutAndRetire(timeline, leftover, 0);
      }

      this.returnDealerGazeToTable(timeline, Math.max(0, ...arrivals) + 0.4);
      if (arrivals.length > 0) {
        const viewerWon = event.awards.some((award) => award.winners.some((w) => w.seat === this.viewerSeat));
        timeline.call(() => this.audio.play('win', { volume: viewerWon ? 1 : 0.6 }), undefined, Math.min(...arrivals));
      }
      this.settlePlayerStacksAtEnd(timeline, next);
    });
  }

  /**
   * Events that carry no 3D change. §4.8 maps them to sync(); that rebuild is skipped while the scene already
   * matches the state, so the winners' highlight and the showdown hand names stay on the table until the next
   * handStart sweeps them. Any divergence still falls back to a full sync().
   */
  private settleWithoutAnimation(next: TableState): Promise<void> {
    const viewerSeat = next.self.seat;
    const upToDate =
      this.sceneHandNumber !== null &&
      JSON.stringify(this.describeScene()) === JSON.stringify(describeState(next, viewerSeat));
    if (upToDate) {
      this.sceneHandNumber = next.handNumber;
      this.refreshLabels();
      this.reconcilePlayerStacks(next);
    } else {
      this.sync(next, viewerSeat);
    }
    return Promise.resolve();
  }

  // ---------------------------------------------------------------------------
  // Scene building blocks
  // ---------------------------------------------------------------------------

  /** Rebuilds from `previous` when the scene belongs to another viewer or hand, then the event animates on top. */
  private ensureSceneMatches(event: GameEvent, previous: TableState, next: TableState): void {
    const isNeutral = ['snapshot', 'handEnd', 'rebuy', 'playerJoined', 'playerLeft', 'info'].includes(event.kind);
    if (isNeutral) return;
    const viewerSeat = next.self.seat;
    const sceneMissing = this.sceneHandNumber === null;
    const viewerChanged = viewerSeat !== this.viewerSeat;
    const handChanged = event.kind !== 'handStart' && this.sceneHandNumber !== next.handNumber;
    if (sceneMissing || viewerChanged || handChanged) this.sync(previous, viewerSeat);
  }

  private buildDeck(): void {
    this.deck.position.set(DECK_POSITION.x, 0, DECK_POSITION.z);
    for (let layer = 0; layer < DECK_CARD_COUNT; layer++) {
      const card = this.cardFactory.createCard(null);
      card.rotation.order = 'YXZ';
      card.rotation.set(0, ((layer % 3) - 1) * 0.03, Math.PI);
      card.position.set(0, CARD_REST_Y + layer * DECK_CARD_PITCH, 0);
      this.deck.add(card);
    }
  }

  private createCard(code: Card | null): CardObject {
    const card = this.cardFactory.createCard(code);
    // Yaw outermost, then tilt, then flip: tilting a flipped card must not depend on the seat orientation.
    card.rotation.order = 'YXZ';
    this.root.add(card);
    return card;
  }

  private spawnAtDeck(code: Card | null, layer: number): CardObject {
    const card = this.createCard(code);
    card.position.copy(deckTopPosition(layer));
    card.rotation.set(0, 0, Math.PI);
    return card;
  }

  private createStackAt(position: THREE.Vector3, amount: number): ChipStack {
    const stack = this.chipFactory.createStack(amount);
    stack.position.set(position.x, FELT_Y, position.z);
    this.root.add(stack);
    return stack;
  }

  private anchorFor(seat: number): SeatAnchor {
    return getSeatAnchor(slotForSeat(seat, this.viewerSeat));
  }

  private betSpot(seat: number): THREE.Vector3 {
    const anchor = this.anchorFor(seat);
    return new THREE.Vector3(anchor.bet.x, FELT_Y, anchor.bet.z);
  }

  private stackPlacement(seat: number): StackPlacement {
    const anchor = this.anchorFor(seat);
    return { position: new THREE.Vector3(anchor.stack.x, FELT_Y, anchor.stack.z), yaw: anchor.stackYaw };
  }

  /** Top of the seat's own stack as it stands now: chips leave from it and land on it. */
  private playerStackTop(seat: number): THREE.Vector3 {
    return this.stackPlacement(seat).position.setY(FELT_Y + this.playerStacks.heightOf(seat));
  }

  private setPlayerStack(seat: number, amount: number): void {
    this.playerStacks.set(seat, amount, this.stackPlacement(seat));
  }

  /** Every stack takes the state's amount at once: joins, leaves, rebuys, and any drift left by an animation. */
  private reconcilePlayerStacks(state: TableState): void {
    for (let seat = 0; seat < MAX_SEATS; seat++) this.setPlayerStack(seat, chipsOf(state, seat));
  }

  /** Killed timelines never reach their end, so a sync that interrupted them is not overwritten afterwards. */
  private settlePlayerStacksAtEnd(timeline: Timeline, state: TableState): void {
    timeline.call(() => this.reconcilePlayerStacks(state), undefined, timeline.duration());
  }

  /** The viewer's own known cards use the lifted hero placement; every other card lies on the felt. */
  private holePose(seat: number, cardIndex: number, faceUp: boolean): CardPose {
    const anchor = this.anchorFor(seat);
    if (faceUp && seat === this.viewerSeat) return heroCardPose(anchor, cardIndex);
    return tableCardPose(anchor, cardIndex, faceUp);
  }

  private restoreSeat(view: SeatView): void {
    const count = heldCardCount(view);
    if (count > 0) this.hands.set(view.seat, this.restoreHand(view, count));
    if (view.bet > 0) this.betStacks.set(view.seat, this.createStackAt(this.betSpot(view.seat), view.bet));
  }

  private restoreHand(view: SeatView, count: number): HandRecord {
    const cards: CardObject[] = [];
    let allKnown = true;
    for (let index = 0; index < count; index++) {
      const code = view.cards?.[index] ?? null;
      if (code === null) allKnown = false;
      const card = this.createCard(code);
      applyPose(card, this.holePose(view.seat, index, code !== null));
      cards.push(card);
    }
    return { cards, faceUp: allKnown };
  }

  /** Fills slots before `firstSlot` that the scene lacks (a missed event), instantly and face-up. */
  private restoreMissingCommunity(board: Card[], firstSlot: number): void {
    for (let slot = 0; slot < firstSlot; slot++) {
      if (this.communityCards[slot]) continue;
      const card = this.createCard(board[slot]);
      applyPose(card, communityCardPose(slot, true));
      this.communityCards[slot] = card;
    }
  }

  /** Returns the seat's hand, creating face-down cards on the felt if the scene never saw them dealt. */
  private ensureHand(seat: number, count: number): HandRecord {
    const existing = this.hands.get(seat);
    if (existing) return existing;
    const cards: CardObject[] = [];
    for (let index = 0; index < count; index++) {
      const card = this.createCard(null);
      applyPose(card, this.holePose(seat, index, false));
      cards.push(card);
    }
    const hand = { cards, faceUp: false };
    this.hands.set(seat, hand);
    return hand;
  }

  private discardHand(seat: number): void {
    const hand = this.hands.get(seat);
    if (!hand) return;
    hand.cards.forEach((card) => this.disposeProp(card));
    this.hands.delete(seat);
  }

  private placePucksInstantly(seats: PuckSeats): void {
    const targets = this.puckTargets(seats);
    for (const key of PUCK_ORDER) {
      const target = targets[key];
      this.pucks[key].visible = target !== null;
      if (target) this.pucks[key].position.copy(target);
    }
    this.puckSeats = { ...seats };
  }

  /**
   * Pucks sharing a seat (heads-up, the dealer button is also the small blind) are stacked, the blind on top: in
   * front of the chip stack there is room for one puck only.
   */
  private puckTargets(seats: PuckSeats): Record<PuckKey, THREE.Vector3 | null> {
    const targets: Record<PuckKey, THREE.Vector3 | null> = { dealer: null, smallBlind: null, bigBlind: null };
    const pileTops = new Map<number, number>();
    for (const key of PUCK_ORDER) {
      const seat = seats[key];
      if (seat === null) continue;
      const bottom = (pileTops.get(seat) ?? FELT_Y) + PUCK_REST_GAP;
      const target = this.anchorFor(seat).button.clone();
      target.y = bottom + this.puckRestHeights[key];
      pileTops.set(seat, bottom + this.puckHeights[key]);
      targets[key] = target;
    }
    return targets;
  }

  private slidePucks(timeline: Timeline, seats: PuckSeats, at: number): void {
    const targets = this.puckTargets(seats);
    for (const key of PUCK_ORDER) {
      const puck = this.pucks[key];
      const target = targets[key];
      if (!target) {
        puck.visible = false;
        continue;
      }
      if (puck.visible && !this.reducedMotion) {
        addArc(timeline, puck.position, puck.position.clone(), target, 0.05, PUCK_SLIDE_SECONDS, at);
        continue;
      }
      puck.position.copy(target);
      puck.visible = true;
      if (this.reducedMotion) continue;
      puck.position.y += 0.08;
      timeline.to(puck.position, { y: target.y, duration: PUCK_DROP_SECONDS, ease: 'bounce.out' }, at);
    }
    this.puckSeats = { ...seats };
  }

  private shuffleDeck(timeline: Timeline): void {
    timeline.call(() => this.audio.play('shuffle'), undefined, 0.05);
    if (this.reducedMotion) return;
    timeline.to(
      this.deck.rotation,
      { y: 0.18, duration: SHUFFLE_WIGGLE_SECONDS, ease: 'sine.inOut', yoyo: true, repeat: 5 },
      0.05,
    );
  }

  /** Previous hand's cards fly to the muck and fade; its chips just fade away. */
  private sweepLeftovers(timeline: Timeline): void {
    const cards = [...this.communityCards, ...[...this.hands.values()].flatMap((hand) => hand.cards)];
    const chips = [...this.betStacks.values(), ...this.potStacks];
    this.communityCards = [];
    this.hands.clear();
    this.betStacks.clear();
    this.potStacks = [];

    const flight = this.span(SWEEP_FLIGHT_SECONDS);
    cards.forEach((card, order) => {
      const at = order * this.step(SWEEP_STAGGER_SECONDS);
      if (this.reducedMotion) {
        this.fadeOutAndRetire(timeline, card, 0);
        return;
      }
      this.moveCard(timeline, card, muckCardPose(order), { at, duration: flight, lift: 0.04 });
      this.fadeOutAndRetire(timeline, card, at + flight);
    });
    chips.forEach((stack) => this.fadeOutAndRetire(timeline, stack, 0));
  }

  /** After both hole cards land, the viewer's own cards lift off the felt and flip face-up. */
  private peekAtOwnCards(timeline: Timeline, lastLanding: Map<number, number>): void {
    const viewerSeat = this.viewerSeat;
    if (viewerSeat === null) return;
    const hand = this.hands.get(viewerSeat);
    const landing = lastLanding.get(viewerSeat);
    if (!hand || landing === undefined || !hand.cards.every((card) => card.card !== null)) return;
    hand.faceUp = true;
    hand.cards.forEach((card, index) => {
      this.moveCard(timeline, card, this.holePose(viewerSeat, index, true), {
        at: landing + this.step(0.05 + index * PEEK_STAGGER_SECONDS),
        duration: this.span(PEEK_SECONDS),
        lift: 0.05,
        sound: 'cardFlip',
      });
    });
  }

  private sendHandToMuck(timeline: Timeline, seat: number, at: number): void {
    const hand = this.hands.get(seat);
    if (!hand) return;
    this.hands.delete(seat);
    const flight = this.span(FOLD_FLIGHT_SECONDS);
    hand.cards.forEach((card, index) => {
      const start = at + index * this.step(0.07);
      if (this.reducedMotion) {
        this.fadeOutAndRetire(timeline, card, start);
        return;
      }
      this.moveCard(timeline, card, muckCardPose(seat * HOLE_CARDS_PER_PLAYER + index), {
        at: start,
        duration: flight,
        lift: 0.06,
      });
      this.fadeOutAndRetire(timeline, card, start + flight);
    });
  }

  /**
   * The chips lift off the top of the player's stack (which shrinks to `chipsLeft` at that moment), fly onto the
   * seat's bet spot and merge into its bet stack. An all-in moves the stack itself instead (see pushStackForward).
   */
  private addChipsToBet(timeline: Timeline, seat: number, moved: number, totalBet: number, chipsLeft: number): void {
    if (moved > 0 && chipsLeft === 0 && this.playerStacks.amountOf(seat) > 0) {
      this.pushStackForward(timeline, seat, totalBet);
      return;
    }
    const duration = this.span(BET_FLIGHT_SECONDS);
    const landing = this.betSpot(seat);
    landing.y += this.betStacks.get(seat)?.topY ?? 0;
    const pan = panFor(landing);

    if (moved > 0) {
      const origin = this.playerStackTop(seat);
      const flying = this.createStackAt(origin, moved);
      flying.position.y = origin.y;
      this.moveStack(timeline, flying, landing, {
        from: flying.position.clone(),
        at: 0,
        duration,
        arcHeight: 0.16,
        fromHidden: true,
      });
      this.retireAt(timeline, flying, duration);
    }
    timeline.call(() => this.setPlayerStack(seat, chipsLeft), undefined, 0);
    timeline.call(
      () => {
        this.setBetStack(seat, totalBet);
        this.refreshLabels();
        if (moved > 0) this.playChipSound(moved, pan);
      },
      undefined,
      duration,
    );
  }

  /**
   * All-in: the player's own chips, exactly as they stood, slide from their spot onto the bet spot and keep that shape
   * there for the rest of the street; chips bet earlier in the street join them as they land.
   */
  private pushStackForward(timeline: Timeline, seat: number, totalBet: number): void {
    const duration = this.span(BET_FLIGHT_SECONDS);
    const placement = this.stackPlacement(seat);
    const landing = this.betSpot(seat);
    const pushed = this.createStackAt(placement.position, this.playerStacks.amountOf(seat));
    pushed.showChips(this.playerStacks.amountOf(seat), this.playerStacks.chipsOf(seat));
    pushed.rotation.y = placement.yaw;
    // Owned by this timeline until it lands: a sync that kills the timeline first must not leave it on the felt.
    this.retiring.add(pushed);

    this.moveStack(timeline, pushed, landing, { from: placement.position.clone(), at: 0, duration, arcHeight: 0.05, fromHidden: true });
    timeline.call(() => this.setPlayerStack(seat, 0), undefined, 0);
    timeline.call(
      () => {
        this.adoptBetStack(seat, pushed, totalBet);
        this.refreshLabels();
        this.playChipSound(totalBet, panFor(landing));
      },
      undefined,
      duration,
    );
  }

  /** The pushed stack becomes the seat's bet stack, holding the whole bet. */
  private adoptBetStack(seat: number, stack: ChipStack, totalBet: number): void {
    this.retiring.delete(stack);
    const previous = this.betStacks.get(seat);
    if (previous && previous !== stack) this.disposeProp(previous);
    if (stack.amount !== totalBet) stack.showChips(totalBet, playerStackChips(totalBet, seat));
    this.betStacks.set(seat, stack);
  }

  private setBetStack(seat: number, amount: number): void {
    const existing = this.betStacks.get(seat);
    if (amount <= 0) {
      if (existing) this.disposeProp(existing);
      this.betStacks.delete(seat);
      return;
    }
    if (existing) {
      existing.setAmount(amount);
      return;
    }
    this.betStacks.set(seat, this.createStackAt(this.betSpot(seat), amount));
  }

  private playChipSound(amount: number, pan: number): void {
    const chipCount = breakdownChips(amount).reduce((total, entry) => total + entry.count, 0);
    if (chipCount >= BIG_BET_CHIP_COUNT) {
      this.audio.play('chipStack', { pan });
      return;
    }
    this.audio.play('chipClink', { pan, count: Math.max(1, Math.min(MAX_CLINK_COUNT, chipCount)) });
  }

  /** An uncalled bet flies back onto its owner's stack, which grows to `chipsAfter` as it lands. */
  private returnToPlayerStack(timeline: Timeline, stack: ChipStack, seat: number, at: number, chipsAfter: number): void {
    const arrival = this.flyIntoPlayerStack(timeline, stack, seat, at, REFUND_FLIGHT_SECONDS, 0.1);
    timeline.call(() => this.setPlayerStack(seat, chipsAfter), undefined, arrival);
  }

  /**
   * Flies a stack onto the top of the seat's own stack and removes it on arrival, the moment the player's stack takes
   * its chips; returns that moment. Reduced motion skips the flight: the chips change hands at once.
   */
  private flyIntoPlayerStack(timeline: Timeline, stack: ChipStack, seat: number, at: number, duration: number, arcHeight: number): number {
    if (this.reducedMotion) {
      this.retireAt(timeline, stack, at);
      return at;
    }
    this.moveStack(timeline, stack, this.playerStackTop(seat), { from: stack.position.clone(), at, duration, arcHeight });
    this.retireAt(timeline, stack, at + duration);
    return at + duration;
  }

  private sendToPot(timeline: Timeline, stack: ChipStack, at: number, duration: number): void {
    this.moveStack(timeline, stack, potPosition(0), {
      from: stack.position.clone(),
      at,
      duration,
      arcHeight: 0.03,
    });
    this.retireAt(timeline, stack, at + duration);
  }

  /** Collected pots update in place; a new pot is born on the main pot and splits off to its own spot. */
  private mergePots(timeline: Timeline, pots: PotView[], at: number): void {
    const livePots = pots.filter((pot) => pot.amount > 0);
    livePots.forEach((pot, index) => {
      const existing = this.potStacks[index];
      if (existing) {
        timeline.call(() => existing.setAmount(pot.amount), undefined, at);
        return;
      }
      const stack = this.createStackAt(potPosition(0), pot.amount);
      stack.visible = false;
      this.potStacks[index] = stack;
      timeline.call(
        () => {
          stack.visible = true;
        },
        undefined,
        at,
      );
      if (index > 0) {
        this.moveStack(timeline, stack, potPosition(index), {
          from: potPosition(0),
          at,
          duration: this.span(POT_SPLIT_SECONDS),
          arcHeight: 0.04,
        });
      }
    });
    for (const surplus of this.potStacks.splice(livePots.length)) {
      this.retireAt(timeline, surplus, at);
    }
    timeline.call(() => this.refreshLabels(), undefined, at);
  }

  /**
   * Slices one pot between its winners: chips lift off, stop at each winner's bet spot, then drop onto the winner's
   * own stack, which grows by the share as they land. Reduced motion hands the share over at once.
   */
  private payWinners(timeline: Timeline, award: AwardView, source: ChipStack, at: number): number[] {
    const origin = source.position.clone();
    const shares = award.winners.length > 1 ? this.createShareStacks(timeline, award, source, at) : [source];
    const liftAt = at + this.step(AWARD_LIFT_DELAY_SECONDS);

    return award.winners.map((winner, index) => {
      const stack = shares[index];
      const betSpot = this.betSpot(winner.seat);
      const pan = panFor(betSpot);
      const start = liftAt + this.step(index * AWARD_SHARE_STAGGER_SECONDS);
      const shareOrigin = shares.length > 1 ? this.shareOrigin(origin, index, shares.length) : origin;

      let dropStart = start;
      if (!this.reducedMotion) {
        this.moveStack(timeline, stack, betSpot, { from: shareOrigin, at: start, duration: AWARD_TO_BET_SECONDS, arcHeight: 0.12 });
        timeline.call(() => this.audio.play('chipsSlide', { pan }), undefined, start);
        dropStart = start + AWARD_TO_BET_SECONDS + AWARD_PAUSE_SECONDS;
      }
      const arrival = this.flyIntoPlayerStack(timeline, stack, winner.seat, dropStart, AWARD_TO_STACK_SECONDS, 0.14);
      timeline.call(
        () => {
          this.setPlayerStack(winner.seat, this.playerStacks.amountOf(winner.seat) + winner.amount);
          this.audio.play('potCollect', { pan });
          this.plates.flashWin(winner.seat, winner.amount);
        },
        undefined,
        arrival,
      );
      return arrival;
    });
  }

  /** A split pot is replaced by one smaller stack per winner, fanned out side by side at the pot spot. */
  private createShareStacks(timeline: Timeline, award: AwardView, source: ChipStack, at: number): ChipStack[] {
    const origin = source.position.clone();
    const shares = award.winners.map((winner, index) => {
      const stack = this.createStackAt(this.shareOrigin(origin, index, award.winners.length), winner.amount);
      stack.visible = false;
      return stack;
    });
    this.retireAt(timeline, source, at);
    timeline.call(
      () => {
        for (const share of shares) share.visible = true;
      },
      undefined,
      at,
    );
    return shares;
  }

  private shareOrigin(origin: THREE.Vector3, index: number, count: number): THREE.Vector3 {
    return origin.clone().add(new THREE.Vector3((index - (count - 1) / 2) * SHARE_SPREAD, 0, 0));
  }

  /** Gold outline for the cards of the winning hands, everything else dimmed. Uncontested pots show no hands. */
  private highlightWinningCards(event: EventOf<'award'>): void {
    if (!event.showdown) return;
    const winning = new Set<Card>(event.awards.flatMap((award) => award.winners.flatMap((w) => w.bestFive)));
    if (winning.size === 0) return;
    const cards = [...this.communityCards, ...[...this.hands.values()].flatMap((hand) => hand.cards)];
    for (const card of cards) {
      if (card.card === null) continue;
      card.setHighlight(winning.has(card.card) ? 'winner' : 'dim');
    }
  }

  private labelWinningHands(event: EventOf<'award'>): void {
    for (const award of event.awards) {
      for (const winner of award.winners) {
        if (winner.handName) this.plates.setHandLabel(winner.seat, winner.handName);
      }
    }
  }

  private pulseCards(timeline: Timeline, cards: CardObject[], at: number): void {
    for (const card of cards) {
      const peak = card.scale.x * 1.08;
      timeline.to(
        card.scale,
        { x: peak, y: peak, z: peak, duration: 0.15, ease: 'sine.out', yoyo: true, repeat: 1 },
        at,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Dealer
  // ---------------------------------------------------------------------------

  /** Cards leave the dealer's hand only when there is a dealer and the player accepts motion. */
  private usesDealerHand(): boolean {
    return this.dealer !== null && !this.reducedMotion;
  }

  /** Real seconds of a dealer gesture that lasts `timelineSeconds` on the (speed scaled) timeline. */
  private gestureSeconds(timelineSeconds: number): number {
    return Math.max(MIN_GESTURE_SECONDS, timelineSeconds / this.playbackSpeed);
  }

  /** Starts a dealer gesture when the timeline reaches `at`; nothing happens without a dealer or with reduced motion. */
  private gestureOnTimeline(
    timeline: Timeline,
    at: number,
    perform: (dealer: Dealer, seconds: number) => Promise<void>,
    timelineSeconds: number,
  ): void {
    const dealer = this.dealer;
    if (!dealer || this.reducedMotion) return;
    const seconds = this.gestureSeconds(timelineSeconds);
    timeline.call(() => void perform(dealer, seconds).catch(() => undefined), undefined, at);
  }

  /**
   * The dealer pitches the card toward `target`: the card appears pinched between his thumb and fingertips as the
   * fingers close, rides them through the wind-up and the flick, and leaves them at the moment of release.
   * Returns when the card leaves (`at` itself when the card simply starts on the deck).
   */
  private pitchCardTo(timeline: Timeline, card: CardObject, target: THREE.Vector3, at: number): number {
    const dealer = this.dealer;
    if (!dealer || this.reducedMotion) return at;
    const destination = target.clone();
    const pinchAt = at + DEAL_GESTURE_SECONDS * DEAL_PICKUP_FRACTION;
    const releaseAt = at + DEAL_GESTURE_SECONDS * DEAL_RELEASE_FRACTION;
    card.visible = false;
    timeline.call(
      () => {
        dealer.lookAt(destination);
        void dealer.gestureDeal(destination, this.gestureSeconds(DEAL_GESTURE_SECONDS)).catch(() => undefined);
      },
      undefined,
      at,
    );
    timeline.call(
      () => {
        card.scale.setScalar(dealer.grippedCardScale);
        card.visible = true;
        dealer.gripWorldPosition('right', card.position);
      },
      undefined,
      pinchAt,
    );
    timeline.to({}, { duration: releaseAt - pinchAt, onUpdate: () => dealer.gripWorldPosition('right', card.position) }, pinchAt);
    timeline.call(() => dealer.gripWorldPosition('right', card.position), undefined, releaseAt);
    return releaseAt;
  }

  /** Quiet-time behaviour of the dealer follows what the table is doing, and he looks at who is actually sitting there. */
  private updateDealerContext(state: TableState): void {
    const dealer = this.dealer;
    if (!dealer) return;
    dealer.setActivity(dealerActivityFor(state));
    const occupied = state.seats.filter((seat): seat is SeatView => seat !== null);
    const slots = occupied.length > 0 ? occupied.map((seat) => slotForSeat(seat.seat, state.self.seat)) : Array.from({ length: SEAT_SLOTS }, (_, slot) => slot);
    dealer.setAttention({
      seatPoints: slots.map((slot) => getSeatAnchor(slot).plate.clone()),
      potPoint: state.pots.some((pot) => pot.amount > 0) ? POT_POSITION.clone() : null,
    });
  }

  private welcomePlayer(seat: number, state: TableState): void {
    this.dealer?.welcomeSeat(getSeatAnchor(slotForSeat(seat, state.self.seat)).plate.clone());
  }

  /** Eyes on the acting seat (or the viewer's own cards); a human opponent also gets an open-palm point. */
  private directDealerAttention(seat: number, state: TableState): void {
    const dealer = this.dealer;
    if (!dealer) return;
    if (seat === this.viewerSeat) {
      dealer.lookAt(this.viewerHandCenter(seat));
      return;
    }
    const plate = this.anchorFor(seat).plate.clone();
    dealer.lookAt(plate);
    if (state.seats[seat]?.isBot === false) dealer.gesturePoint(plate);
  }

  private viewerHandCenter(seat: number): THREE.Vector3 {
    const first = this.holePose(seat, 0, true).position;
    const second = this.holePose(seat, 1, true).position;
    return first.clone().lerp(second, 0.5);
  }

  private returnDealerGazeToTable(timeline: Timeline, at: number): void {
    const dealer = this.dealer;
    if (!dealer) return;
    timeline.call(() => dealer.lookAt(null), undefined, at);
  }

  // ---------------------------------------------------------------------------
  // Motion helpers
  // ---------------------------------------------------------------------------

  private span(seconds: number): number {
    return this.reducedMotion ? REDUCED_MOTION_SECONDS : seconds;
  }

  private step(seconds: number): number {
    return this.reducedMotion ? 0 : seconds;
  }

  private moveCard(timeline: Timeline, card: CardObject, pose: CardPose, options: CardMoveOptions): void {
    const { at, duration } = options;
    const sound = options.sound;
    if (sound) {
      timeline.call(
        () => this.audio.play(sound, { pan: options.pan }),
        undefined,
        this.reducedMotion ? at : at + duration * 0.4,
      );
    }
    if (this.reducedMotion) {
      this.popIn(timeline, card, at, pose.scale, () => applyPose(card, pose), options.fromHidden === true);
      return;
    }

    timeline.call(() => card.setInHand(pose.inHand === true), undefined, at);
    const peak = Math.max(card.position.y, pose.position.y) + options.lift;
    timeline.to(card.position, { x: pose.position.x, z: pose.position.z, duration, ease: 'power2.inOut' }, at);
    timeline.to(card.position, { y: peak, duration: duration / 2, ease: 'power2.out' }, at);
    timeline.to(card.position, { y: pose.position.y, duration: duration / 2, ease: 'power2.in' }, at + duration / 2);
    timeline.to(
      card.rotation,
      {
        x: pose.rotation.x,
        y: pose.rotation.y + (options.spinTurns ?? 0) * FULL_TURN,
        z: pose.rotation.z,
        duration,
        ease: 'power2.inOut',
        // Whole extra turns are invisible; reset so later tweens start from the canonical angle.
        onComplete: () => {
          card.rotation.y = pose.rotation.y;
        },
      },
      at,
    );
    timeline.to(card.scale, { x: pose.scale, y: pose.scale, z: pose.scale, duration, ease: 'power2.inOut' }, at);
  }

  private moveStack(timeline: Timeline, stack: ChipStack, to: THREE.Vector3, options: StackMoveOptions): void {
    if (this.reducedMotion) {
      this.popIn(timeline, stack, options.at, stack.scale.x, () => stack.position.copy(to), options.fromHidden === true);
      return;
    }
    addArc(timeline, stack.position, options.from, to, options.arcHeight, options.duration, options.at);
  }

  /** Reduced-motion replacement for a flight: the object appears at its destination with a quick scale fade-in. */
  private popIn(
    timeline: Timeline,
    object: THREE.Object3D,
    at: number,
    finalScale: number,
    place: () => void,
    hideUntilThen: boolean,
  ): void {
    if (hideUntilThen) object.visible = false;
    timeline.call(
      () => {
        place();
        object.visible = true;
      },
      undefined,
      at,
    );
    timeline.fromTo(
      object.scale,
      { x: 0.01, y: 0.01, z: 0.01 },
      { x: finalScale, y: finalScale, z: finalScale, duration: REDUCED_MOTION_SECONDS, ease: 'power1.out', immediateRender: false },
      at,
    );
  }

  private fadeOutAndRetire(timeline: Timeline, prop: CardObject | ChipStack, at: number): void {
    timeline.to(prop.scale, { x: 0.001, y: 0.001, z: 0.001, duration: FADE_SECONDS, ease: 'power2.in' }, at);
    this.retireAt(timeline, prop, at + FADE_SECONDS);
  }

  private retireAt(timeline: Timeline, prop: CardObject | ChipStack, at: number): void {
    this.retiring.add(prop);
    timeline.call(() => this.disposeProp(prop), undefined, at);
  }

  /** Camera drama for all-ins; skipped while catching up on a backlog or in reduced motion. */
  private emphasize(target: THREE.Vector3, speed: number): void {
    if (this.reducedMotion || speed > FAST_FORWARD_SPEED) return;
    this.stage.shake();
    this.stage.dramaticZoom(target, undefined, ZOOM_SECONDS / speed).catch(() => undefined);
  }

  private runTimeline(speed: number, build: (timeline: Timeline) => void): Promise<void> {
    return new Promise<void>((resolve) => {
      this.playbackSpeed = Math.max(speed, MIN_SPEED);
      const timeline = gsap.timeline({ paused: true });
      const play: RunningPlay = { timeline, finish: resolve };
      this.running.add(play);
      try {
        build(timeline);
      } catch (error) {
        this.running.delete(play);
        timeline.kill();
        throw error;
      }
      timeline.to({}, { duration: MIN_TIMELINE_SECONDS }, 0);
      timeline.eventCallback('onComplete', () => {
        this.running.delete(play);
        resolve();
      });
      timeline.timeScale(Math.max(speed, MIN_SPEED));
      timeline.play(0);
    });
  }

  // ---------------------------------------------------------------------------
  // Bookkeeping
  // ---------------------------------------------------------------------------

  private describeScene(): SceneDescription {
    const hands: Record<number, string[]> = {};
    for (const [seat, hand] of this.hands) {
      hands[seat] = hand.cards.map((card) => (hand.faceUp ? (card.card ?? UNKNOWN_CARD) : UNKNOWN_CARD));
    }
    const bets: Record<number, number> = {};
    for (const [seat, stack] of this.betStacks) bets[seat] = stack.amount;
    return {
      viewerSeat: this.viewerSeat,
      pucks: { ...this.puckSeats },
      hands,
      bets,
      community: this.communityCards.map((card) => card.card ?? UNKNOWN_CARD),
      pots: this.potStacks.map((stack) => stack.amount),
    };
  }

  private refreshLabels(): void {
    for (let seat = 0; seat < MAX_SEATS; seat++) {
      const stack = this.betStacks.get(seat);
      this.plates.setBetLabel(seat, stack && stack.amount > 0 ? stack.amount : null);
    }
    const potTotal = this.potStacks.reduce((total, stack) => total + stack.amount, 0);
    this.plates.setPotLabel(potTotal > 0 ? formatPotLabel(potTotal, this.potStacks.length) : null);
  }

  private clearHandLabels(): void {
    for (let seat = 0; seat < MAX_SEATS; seat++) this.plates.setHandLabel(seat, null);
  }

  /**
   * The protocol only carries hand names inside the reveal event, so a rebuilt showdown, and each street dealt
   * after an all-in reveal, derives them from the cards.
   */
  private restoreHandLabels(state: TableState, viewerSeat: number | null): void {
    const othersRevealed = state.seats.some(
      (view) => view !== null && view.seat !== viewerSeat && heldCardCount(view) > 0 && view.cards !== null,
    );
    if (!othersRevealed) return;
    for (const view of state.seats) {
      if (!view || view.status === 'folded' || view.cards === null) continue;
      const label = describeRevealedHand(view.cards, state.community);
      if (label) this.plates.setHandLabel(view.seat, label);
    }
  }

  private clearScene(): void {
    for (const hand of this.hands.values()) hand.cards.forEach((card) => this.disposeProp(card));
    this.hands.clear();
    for (const stack of this.betStacks.values()) this.disposeProp(stack);
    this.betStacks.clear();
    this.communityCards.forEach((card) => this.disposeProp(card));
    this.communityCards = [];
    this.potStacks.forEach((stack) => this.disposeProp(stack));
    this.potStacks = [];
    this.puckSeats = { dealer: null, smallBlind: null, bigBlind: null };
    for (const key of PUCK_ORDER) this.pucks[key].visible = false;
    this.playerStacks.clear();
  }

  /** Stops every running timeline (their promises still resolve) and disposes objects they were still carrying. */
  private abortRunning(): void {
    for (const play of [...this.running]) {
      play.timeline.kill();
      play.finish();
    }
    this.running.clear();
    for (const prop of [...this.retiring]) this.disposeProp(prop);
    this.retiring.clear();
    gsap.killTweensOf([this.deck.rotation, ...PUCK_ORDER.map((key) => this.pucks[key].position)]);
    this.deck.rotation.set(0, 0, 0);
  }

  private disposeProp(prop: CardObject | ChipStack): void {
    this.retiring.delete(prop);
    gsap.killTweensOf([prop.position, prop.rotation, prop.scale]);
    prop.removeFromParent();
    prop.dispose();
  }
}
