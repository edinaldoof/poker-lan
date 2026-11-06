import type { Card } from '../../shared/cards';
import { formatChips } from '../../shared/format';
import { evaluateHand, type HandResult } from '../../shared/handEvaluator';
import {
  MAX_SEATS,
  type ActionType,
  type LegalActions,
  type PlayerActionRequest,
  type Street,
} from '../../shared/protocol';
import { shuffledDeck } from './Deck';
import { buildPots, splitPot, type ContributionEntry, type Pot } from './pots';

export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineError';
  }
}

export interface EngineConfig {
  smallBlind: number;
  bigBlind: number;
}

export interface EnginePlayerState {
  seat: number;
  playerId: string;
  chips: number;
  streetBet: number;
  contribution: number;
  holeCards: Card[];
  inHand: boolean;
  folded: boolean;
  allIn: boolean;
  sittingOut: boolean;
}

export interface HandStartResult {
  handNumber: number;
  dealerSeat: number;
  smallBlindSeat: number;
  bigBlindSeat: number;
  blinds: { seat: number; amount: number; blind: 'small' | 'big' }[];
  /** Seats receiving cards, starting left of the dealer; each gets 2 cards (2 rounds). */
  dealOrder: number[];
}

export interface ActionResult {
  seat: number;
  action: ActionType;
  /** Chips moved by this action alone. */
  amount: number;
  /** The player's total bet on the current street after the action. */
  totalBet: number;
  allIn: boolean;
  roundComplete: boolean;
  handComplete: boolean;
  nextActor: number | null;
}

export interface CollectResult {
  returned: { seat: number; amount: number }[];
  pots: Pot[];
  collected: number;
}

export interface AwardWinner {
  seat: number;
  amount: number;
  hand: HandResult | null;
}

export interface Award {
  potIndex: number;
  amount: number;
  winners: AwardWinner[];
}

export interface SettleResult {
  showdown: boolean;
  awards: Award[];
  hands: Map<number, HandResult>;
}

export interface FoldOutOfTurnResult {
  handComplete: boolean;
  roundComplete: boolean;
  nextActor: number | null;
}

interface SeatState {
  seat: number;
  playerId: string;
  chips: number;
  streetBet: number;
  contribution: number;
  holeCards: Card[];
  inHand: boolean;
  folded: boolean;
  allIn: boolean;
  sittingOut: boolean;
  /** False means the player still owes a decision on the current bet level. */
  hasActed: boolean;
  /** Current bet level when the player last acted this street; null until they act. Drives the reopen rule. */
  lastActionLevel: number | null;
}

type DealtStreet = 'flop' | 'turn' | 'river';

const HOLE_CARDS_PER_PLAYER = 2;
const FLOP_SIZE = 3;
const COMMUNITY_CARDS_AT_SHOWDOWN = 5;
const STREET_AFTER: Partial<Record<Street, DealtStreet>> = { preflop: 'flop', flop: 'turn', turn: 'river' };
const BETTING_STREETS: ReadonlySet<Street> = new Set<Street>(['flop', 'turn', 'river']);

/** Seats are clockwise by increasing index; the origin seat itself counts as the farthest one. */
function clockwiseDistance(originSeat: number, seat: number): number {
  return (seat - originSeat - 1 + MAX_SEATS) % MAX_SEATS;
}

function seatsClockwiseAfter(originSeat: number, seats: number[]): number[] {
  return [...seats].sort((a, b) => clockwiseDistance(originSeat, a) - clockwiseDistance(originSeat, b));
}

function isOccupied(seatState: SeatState | null): seatState is SeatState {
  return seatState !== null;
}

function cloneSeatState(player: SeatState): EnginePlayerState {
  return {
    seat: player.seat,
    playerId: player.playerId,
    chips: player.chips,
    streetBet: player.streetBet,
    contribution: player.contribution,
    holeCards: [...player.holeCards],
    inHand: player.inHand,
    folded: player.folded,
    allIn: player.allIn,
    sittingOut: player.sittingOut,
  };
}

function clonePots(pots: Pot[]): Pot[] {
  return pots.map((pot) => ({ amount: pot.amount, eligibleSeats: [...pot.eligibleSeats] }));
}

function assertValidConfig(config: EngineConfig): void {
  const { smallBlind, bigBlind } = config;
  if (!Number.isInteger(smallBlind) || !Number.isInteger(bigBlind) || smallBlind < 1 || bigBlind < smallBlind) {
    throw new EngineError('Blinds must be integers with 1 <= smallBlind <= bigBlind');
  }
}

function assertSeatIndex(seat: number): void {
  if (!Number.isInteger(seat) || seat < 0 || seat >= MAX_SEATS) {
    throw new EngineError(`Seat must be an integer between 0 and ${MAX_SEATS - 1}`);
  }
}

/**
 * Pure No-Limit Hold'em rules. The caller (GameController) owns pacing and I/O and drives the hand with:
 * startHand -> act* -> collectBets -> (dealNextStreet -> beginBettingRound -> act* -> collectBets)* -> settle -> endHand.
 *
 * Deck consumption order, with no burn cards: hole cards are taken from index 0 in `dealOrder` for two rounds
 * (n cards for the first round, n for the second), then the flop (3 cards), the turn (1) and the river (1).
 */
export class TableEngine {
  private config: EngineConfig;
  private readonly deckFactory: () => Card[];
  private readonly seats: (SeatState | null)[] = Array.from({ length: MAX_SEATS }, () => null);
  /** Folded players removed mid-hand: their chips stay in the pot until the hand ends. */
  private departedPlayers: SeatState[] = [];
  private handCounter = 0;
  private currentStreet: Street = 'idle';
  private dealer: number | null = null;
  private smallBlindPosition: number | null = null;
  private bigBlindPosition: number | null = null;
  private communityCards: Card[] = [];
  private deck: Card[] = [];
  private deckPosition = 0;
  private highestBet = 0;
  private minRaise: number;
  private actor: number | null = null;
  private collectedPots: Pot[] = [];
  private settled = false;

  constructor(config: EngineConfig, deckFactory: () => Card[] = () => shuffledDeck()) {
    assertValidConfig(config);
    this.config = { ...config };
    this.minRaise = config.bigBlind;
    this.deckFactory = deckFactory;
  }

  setConfig(config: EngineConfig): void {
    if (this.isHandInProgress()) {
      throw new EngineError('Blinds cannot change while a hand is in progress');
    }
    assertValidConfig(config);
    this.config = { ...config };
    this.minRaise = config.bigBlind;
  }

  // ---------------------------------------------------------------- seats

  seatPlayer(seat: number, playerId: string, chips: number): void {
    assertSeatIndex(seat);
    if (!Number.isInteger(chips) || chips < 0) {
      throw new EngineError('Chips must be a non-negative integer');
    }
    if (this.seats[seat] !== null) {
      throw new EngineError(`Seat ${seat} is already taken`);
    }
    this.seats[seat] = {
      seat,
      playerId,
      chips,
      streetBet: 0,
      contribution: 0,
      holeCards: [],
      inHand: false,
      folded: false,
      allIn: false,
      sittingOut: false,
      hasActed: false,
      lastActionLevel: null,
    };
  }

  /**
   * Between `settle()` and `endHand()` the hand is still open, so a winner who did not fold cannot be removed
   * yet: callers must defer the removal until `endHand()` has run.
   */
  removePlayer(seat: number): void {
    assertSeatIndex(seat);
    const player = this.seats[seat];
    if (!player) return;
    if (this.isHandInProgress() && player.inHand) {
      if (!player.folded) {
        throw new EngineError(`Seat ${seat} is still playing the current hand`);
      }
      this.departedPlayers.push(player);
    }
    this.seats[seat] = null;
  }

  /**
   * Rebuy. Allowed between hands, for seats that are not in the hand, and for players who already folded (their
   * pot share lives in `contribution`, so extra chips cannot change it). Throws for a player still contending,
   * which includes the winners between `settle()` and `endHand()`.
   */
  addChips(seat: number, amount: number): void {
    const player = this.requirePlayer(seat);
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new EngineError('Chips to add must be a positive integer');
    }
    if (this.isHandInProgress() && player.inHand && !player.folded) {
      throw new EngineError(`Seat ${seat} cannot add chips while playing a hand`);
    }
    player.chips += amount;
  }

  setSittingOut(seat: number, sittingOut: boolean): void {
    this.requirePlayer(seat).sittingOut = sittingOut;
  }

  getPlayer(seat: number): EnginePlayerState | null {
    const player = Number.isInteger(seat) ? (this.seats[seat] ?? null) : null;
    return player ? cloneSeatState(player) : null;
  }

  getPlayers(): EnginePlayerState[] {
    return this.occupiedSeats().map(cloneSeatState);
  }

  // ---------------------------------------------------------------- state

  get handNumber(): number {
    return this.handCounter;
  }

  get street(): Street {
    return this.currentStreet;
  }

  get dealerSeat(): number | null {
    return this.dealer;
  }

  get smallBlindSeat(): number | null {
    return this.smallBlindPosition;
  }

  get bigBlindSeat(): number | null {
    return this.bigBlindPosition;
  }

  get community(): Card[] {
    return [...this.communityCards];
  }

  get currentBet(): number {
    return this.highestBet;
  }

  get actingSeat(): number | null {
    return this.actor;
  }

  /** Collected pots only; chips still in front of players are in `totalPot()`. */
  get pots(): Pot[] {
    return clonePots(this.collectedPots);
  }

  isHandInProgress(): boolean {
    return this.currentStreet !== 'idle';
  }

  eligibleSeats(): number[] {
    return this.occupiedSeats()
      .filter((player) => player.chips > 0 && !player.sittingOut)
      .map((player) => player.seat);
  }

  canStartHand(): boolean {
    return !this.isHandInProgress() && this.eligibleSeats().length >= 2;
  }

  nonFoldedSeats(): number[] {
    return this.playersInHand()
      .filter((player) => !player.folded)
      .map((player) => player.seat);
  }

  /** True when at least two players are live but at most one of them can still bet. */
  isAllInRunout(): boolean {
    const live = this.playersInHand().filter((player) => !player.folded);
    return live.length >= 2 && live.filter((player) => !player.allIn).length <= 1;
  }

  totalPot(): number {
    const collected = this.collectedPots.reduce((sum, pot) => sum + pot.amount, 0);
    const inFront = this.handParticipants().reduce((sum, player) => sum + player.streetBet, 0);
    return collected + inFront;
  }

  // ---------------------------------------------------------------- hand lifecycle

  startHand(): HandStartResult {
    if (this.isHandInProgress()) {
      throw new EngineError('A hand is already in progress');
    }
    const eligible = this.eligibleSeats();
    if (eligible.length < 2) {
      throw new EngineError('At least two players with chips are needed to start a hand');
    }

    const dealerSeat = this.dealer === null ? eligible[0] : seatsClockwiseAfter(this.dealer, eligible)[0];
    // Heads-up the dealer posts the small blind; otherwise the blinds follow the dealer.
    const smallBlindSeat = eligible.length === 2 ? dealerSeat : seatsClockwiseAfter(dealerSeat, eligible)[0];
    const bigBlindSeat = seatsClockwiseAfter(smallBlindSeat, eligible)[0];
    const dealOrder = seatsClockwiseAfter(dealerSeat, eligible);

    const deck = [...this.deckFactory()];
    if (deck.length < dealOrder.length * HOLE_CARDS_PER_PLAYER + COMMUNITY_CARDS_AT_SHOWDOWN) {
      throw new EngineError('The deck does not have enough cards for this hand');
    }

    this.resetForNewHand(eligible);
    this.handCounter += 1;
    this.deck = deck;
    this.deckPosition = 0;
    this.dealer = dealerSeat;
    this.smallBlindPosition = smallBlindSeat;
    this.bigBlindPosition = bigBlindSeat;
    this.currentStreet = 'preflop';

    const blinds = [
      this.postBlind(smallBlindSeat, this.config.smallBlind, 'small'),
      this.postBlind(bigBlindSeat, this.config.bigBlind, 'big'),
    ];
    // The bet to match is the nominal big blind even when the big blind could only post part of it.
    this.highestBet = this.config.bigBlind;
    this.minRaise = this.config.bigBlind;

    this.dealHoleCards(dealOrder);
    this.actor = this.findNextActor(bigBlindSeat);

    return {
      handNumber: this.handCounter,
      dealerSeat,
      smallBlindSeat,
      bigBlindSeat,
      blinds,
      dealOrder,
    };
  }

  getLegalActions(seat: number): LegalActions | null {
    if (seat !== this.actor) return null;
    return this.computeLegalActions(this.requirePlayer(seat));
  }

  act(seat: number, request: PlayerActionRequest): ActionResult {
    const player = this.requireActingPlayer(seat);
    const legal = this.computeLegalActions(player);
    const outcome = this.applyRequest(player, legal, request);

    player.hasActed = true;
    player.lastActionLevel = this.highestBet;
    const completion = this.advanceAfterAction(seat);

    return {
      seat,
      action: outcome.action,
      amount: outcome.amount,
      totalBet: player.streetBet,
      allIn: player.chips === 0,
      ...completion,
    };
  }

  /** Folds a player who left the table, whether or not it is their turn. */
  foldOutOfTurn(seat: number): FoldOutOfTurnResult {
    const player = this.requirePlayer(seat);
    const canStillFold =
      this.isHandInProgress() &&
      !this.settled &&
      player.inHand &&
      !player.folded &&
      // The last live player is never folded: the hand is already decided in their favour.
      this.nonFoldedSeats().length > 1;
    if (!canStillFold) return this.completionStatus();

    player.folded = true;
    this.actor = this.actorAfterOutOfTurnFold();
    return this.completionStatus();
  }

  beginBettingRound(): number | null {
    if (!BETTING_STREETS.has(this.currentStreet) || this.settled) {
      throw new EngineError('A betting round can only start on the flop, turn or river');
    }
    if (this.actor !== null) {
      throw new EngineError('The betting round is already open');
    }
    this.actor = this.findNextActor(this.requireDealerSeat());
    return this.actor;
  }

  collectBets(): CollectResult {
    this.assertBettingClosed('collect bets');

    const returned = this.returnUncalledBet();
    let collected = 0;
    for (const player of this.handParticipants()) {
      collected += player.streetBet;
      player.streetBet = 0;
    }
    this.collectedPots = buildPots(this.contributionEntries());
    this.resetStreetState();

    return { returned, pots: clonePots(this.collectedPots), collected };
  }

  dealNextStreet(): { street: DealtStreet; cards: Card[] } {
    const nextStreet = STREET_AFTER[this.currentStreet];
    if (!nextStreet || this.settled) {
      throw new EngineError(`No street can be dealt after ${this.currentStreet}`);
    }
    this.assertBettingClosed('deal the next street');
    if (this.handParticipants().some((player) => player.streetBet > 0)) {
      throw new EngineError('Bets must be collected before dealing the next street');
    }

    this.resetStreetState();
    const cardCount = nextStreet === 'flop' ? FLOP_SIZE : 1;
    const cards = Array.from({ length: cardCount }, () => this.drawCard());
    this.communityCards.push(...cards);
    this.currentStreet = nextStreet;
    return { street: nextStreet, cards: [...cards] };
  }

  settle(): SettleResult {
    if (!this.isHandInProgress() || this.settled) {
      throw new EngineError('There is no unsettled hand');
    }
    this.assertBettingClosed('settle');
    if (this.handParticipants().some((player) => player.streetBet > 0)) {
      throw new EngineError('Bets must be collected before settling');
    }

    // Rebuilt here so a player who left after the last collection stops being eligible.
    this.collectedPots = buildPots(this.contributionEntries());
    const contenders = this.playersInHand().filter((player) => !player.folded);
    if (contenders.length === 0) {
      throw new EngineError('Every player folded: nothing to award');
    }

    const result =
      contenders.length === 1 ? this.awardUncontested(contenders[0]) : this.awardAtShowdown(contenders);
    for (const award of result.awards) {
      for (const winner of award.winners) {
        this.requirePlayer(winner.seat).chips += winner.amount;
      }
    }

    this.collectedPots = [];
    this.settled = true;
    return result;
  }

  /** Clears per-hand flags and returns the seats that played the hand and now have no chips. */
  endHand(): number[] {
    if (!this.isHandInProgress() || !this.settled) {
      throw new EngineError('endHand requires a settled hand');
    }
    const bustedSeats = this.playersInHand()
      .filter((player) => player.chips === 0)
      .map((player) => player.seat);

    // Hole cards, board and button seats stay readable until the next startHand so the table can still show them.
    for (const player of this.occupiedSeats()) {
      player.inHand = false;
      this.resetBettingState(player);
    }
    this.departedPlayers = [];
    this.highestBet = 0;
    this.minRaise = this.config.bigBlind;
    this.actor = null;
    this.currentStreet = 'idle';
    return bustedSeats;
  }

  // ---------------------------------------------------------------- dealing and blinds

  private resetForNewHand(eligibleSeats: number[]): void {
    for (const player of this.occupiedSeats()) {
      player.holeCards = [];
      player.inHand = eligibleSeats.includes(player.seat);
      this.resetBettingState(player);
    }
    this.departedPlayers = [];
    this.communityCards = [];
    this.collectedPots = [];
    this.settled = false;
    this.actor = null;
    this.highestBet = 0;
  }

  private resetBettingState(player: SeatState): void {
    player.streetBet = 0;
    player.contribution = 0;
    player.folded = false;
    player.allIn = false;
    player.hasActed = false;
    player.lastActionLevel = null;
  }

  private postBlind(
    seat: number,
    nominalAmount: number,
    blind: 'small' | 'big',
  ): HandStartResult['blinds'][number] {
    const player = this.requirePlayer(seat);
    const amount = Math.min(player.chips, nominalAmount);
    this.commitChips(player, amount);
    return { seat, amount, blind };
  }

  private dealHoleCards(dealOrder: number[]): void {
    for (let round = 0; round < HOLE_CARDS_PER_PLAYER; round++) {
      for (const seat of dealOrder) {
        this.requirePlayer(seat).holeCards.push(this.drawCard());
      }
    }
  }

  private drawCard(): Card {
    const card = this.deck[this.deckPosition];
    this.deckPosition += 1;
    return card;
  }

  private commitChips(player: SeatState, amount: number): void {
    player.chips -= amount;
    player.streetBet += amount;
    player.contribution += amount;
    if (player.chips === 0) player.allIn = true;
  }

  // ---------------------------------------------------------------- betting rules

  private computeLegalActions(player: SeatState): LegalActions {
    const toCall = this.highestBet - player.streetBet;
    const maxRaiseTo = player.streetBet + player.chips;
    return {
      canFold: true,
      canCheck: toCall === 0,
      canCall: toCall > 0,
      callAmount: Math.min(toCall, player.chips),
      canRaise: maxRaiseTo > this.highestBet && this.someoneCanRespondTo(player) && this.hasRaiseRights(player),
      minRaiseTo: Math.min(this.highestBet + this.minRaise, maxRaiseTo),
      maxRaiseTo,
      isOpeningBet: this.highestBet === 0,
    };
  }

  private someoneCanRespondTo(player: SeatState): boolean {
    return this.playersInHand().some((other) => other.seat !== player.seat && !other.folded && !other.allIn);
  }

  /**
   * A short all-in raise does not reopen the betting for players who already acted: they may raise again
   * only once the bet has grown by at least a full raise since their last action.
   */
  private hasRaiseRights(player: SeatState): boolean {
    return player.lastActionLevel === null || this.highestBet - player.lastActionLevel >= this.minRaise;
  }

  private applyRequest(
    player: SeatState,
    legal: LegalActions,
    request: PlayerActionRequest,
  ): { action: ActionType; amount: number } {
    switch (request.type) {
      case 'fold':
        player.folded = true;
        return { action: 'fold', amount: 0 };
      case 'check':
        if (!legal.canCheck) throw new EngineError('Não é possível dar check: há uma aposta a pagar.');
        return { action: 'check', amount: 0 };
      case 'call':
        if (!legal.canCall) throw new EngineError('Não há aposta a pagar; use check.');
        return this.payToCall(player, legal.callAmount);
      case 'raise':
        return this.raiseWithAmount(player, legal, request.amount);
      case 'allIn':
        return this.goAllIn(player, legal);
      default:
        throw new EngineError('Ação desconhecida.');
    }
  }

  private payToCall(player: SeatState, callAmount: number): { action: ActionType; amount: number } {
    this.commitChips(player, callAmount);
    return { action: player.allIn ? 'allIn' : 'call', amount: callAmount };
  }

  private raiseWithAmount(
    player: SeatState,
    legal: LegalActions,
    amount: number | undefined,
  ): { action: ActionType; amount: number } {
    if (!legal.canRaise) throw new EngineError('Você não pode aumentar agora.');
    if (typeof amount !== 'number' || !Number.isInteger(amount)) {
      throw new EngineError('O valor da aposta deve ser um número inteiro de fichas.');
    }
    if (amount < legal.minRaiseTo) {
      throw new EngineError(`O mínimo para aumentar é ${formatChips(legal.minRaiseTo)}.`);
    }
    if (amount > legal.maxRaiseTo) {
      throw new EngineError(`Você só tem fichas para apostar até ${formatChips(legal.maxRaiseTo)}.`);
    }
    return this.raiseTo(player, amount);
  }

  private goAllIn(player: SeatState, legal: LegalActions): { action: ActionType; amount: number } {
    if (legal.canRaise) return this.raiseTo(player, legal.maxRaiseTo);
    // Nobody can answer a raise (or the action is not reopened): all-in degrades to a call.
    if (legal.canCall) return this.payToCall(player, legal.callAmount);
    return { action: 'check', amount: 0 };
  }

  private raiseTo(player: SeatState, totalBet: number): { action: ActionType; amount: number } {
    const wasOpeningBet = this.highestBet === 0;
    const raiseSize = totalBet - this.highestBet;
    const chipsMoved = totalBet - player.streetBet;

    this.commitChips(player, chipsMoved);
    if (raiseSize >= this.minRaise) this.minRaise = raiseSize;
    this.highestBet = totalBet;

    for (const other of this.playersInHand()) {
      if (other.seat !== player.seat && !other.folded && !other.allIn) other.hasActed = false;
    }

    const action: ActionType = player.allIn ? 'allIn' : wasOpeningBet ? 'bet' : 'raise';
    return { action, amount: chipsMoved };
  }

  // ---------------------------------------------------------------- turn order

  private requireActingPlayer(seat: number): SeatState {
    if (this.actor === null || seat !== this.actor) {
      throw new EngineError('Não é a sua vez de agir.');
    }
    return this.requirePlayer(seat);
  }

  /**
   * Seats that still owe a decision. A lone player who can act, with nothing left to match, has nobody left to
   * bet against (everyone else is all-in or folded), so the street is over for them.
   */
  private seatsNeedingAction(): number[] {
    const live = this.playersInHand().filter((player) => !player.folded);
    if (live.length < 2) return [];

    const canAct = live.filter((player) => !player.allIn);
    if (canAct.length === 1 && this.hasMatchedEveryOpponent(canAct[0], live)) return [];

    return canAct
      .filter((player) => !player.hasActed || player.streetBet < this.highestBet)
      .map((player) => player.seat);
  }

  /**
   * Compares against the opponents' real street bets rather than `highestBet`: when the big blind is all-in for
   * less than the nominal blind, `highestBet` stays at the nominal amount and nobody holds it.
   */
  private hasMatchedEveryOpponent(player: SeatState, live: SeatState[]): boolean {
    const largestOpposingBet = Math.max(
      ...live.filter((other) => other.seat !== player.seat).map((other) => other.streetBet),
    );
    return player.streetBet >= largestOpposingBet;
  }

  private findNextActor(afterSeat: number): number | null {
    return seatsClockwiseAfter(afterSeat, this.seatsNeedingAction())[0] ?? null;
  }

  private advanceAfterAction(actorSeat: number): FoldOutOfTurnResult {
    const handComplete = this.nonFoldedSeats().length <= 1;
    this.actor = handComplete ? null : this.findNextActor(actorSeat);
    return { handComplete, roundComplete: this.actor === null, nextActor: this.actor };
  }

  private actorAfterOutOfTurnFold(): number | null {
    if (this.actor === null || this.nonFoldedSeats().length <= 1) return null;
    if (this.seatsNeedingAction().includes(this.actor)) return this.actor;
    return this.findNextActor(this.actor);
  }

  private completionStatus(): FoldOutOfTurnResult {
    const handComplete = this.isHandInProgress() && !this.settled && this.nonFoldedSeats().length <= 1;
    return { handComplete, roundComplete: this.actor === null, nextActor: this.actor };
  }

  // ---------------------------------------------------------------- collecting and settling

  private assertBettingClosed(operation: string): void {
    if (!this.isHandInProgress() || this.settled) {
      throw new EngineError(`Cannot ${operation} without an active hand`);
    }
    if (this.actor !== null) {
      throw new EngineError(`Cannot ${operation} while seat ${this.actor} still has to act`);
    }
  }

  private resetStreetState(): void {
    this.highestBet = 0;
    this.minRaise = this.config.bigBlind;
    for (const player of this.playersInHand()) {
      player.hasActed = false;
      player.lastActionLevel = null;
    }
  }

  /**
   * Gives back the part of the highest street bet that nobody matched, even when its owner folded afterwards
   * (a player who raised and then left): those chips were never at risk. A folded player already removed from
   * the table has no stack to credit, so their surplus stays in the pot instead of vanishing.
   */
  private returnUncalledBet(): { seat: number; amount: number }[] {
    const byStreetBet = [...this.handParticipants()].sort((a, b) => b.streetBet - a.streetBet);
    const [top, runnerUp] = byStreetBet;
    const matchedAmount = runnerUp?.streetBet ?? 0;
    if (!top || top.streetBet <= matchedAmount || this.departedPlayers.includes(top)) return [];

    const amount = top.streetBet - matchedAmount;
    top.chips += amount;
    top.streetBet -= amount;
    top.contribution -= amount;
    return [{ seat: top.seat, amount }];
  }

  private contributionEntries(): ContributionEntry[] {
    return this.handParticipants().map((player) => ({
      seat: player.seat,
      contribution: player.contribution,
      folded: player.folded,
    }));
  }

  private awardUncontested(winner: SeatState): SettleResult {
    const awards = this.collectedPots.map((pot, potIndex) => ({
      potIndex,
      amount: pot.amount,
      winners: [{ seat: winner.seat, amount: pot.amount, hand: null }],
    }));
    return { showdown: false, awards, hands: new Map() };
  }

  private awardAtShowdown(contenders: SeatState[]): SettleResult {
    if (this.communityCards.length !== COMMUNITY_CARDS_AT_SHOWDOWN) {
      throw new EngineError('A showdown needs five community cards');
    }
    const hands = new Map<number, HandResult>(
      contenders.map((player) => [player.seat, evaluateHand([...player.holeCards, ...this.communityCards])]),
    );
    const awards = this.collectedPots.map((pot, potIndex) => this.awardPot(pot, potIndex, hands));
    this.currentStreet = 'showdown';
    return { showdown: true, awards, hands };
  }

  private awardPot(pot: Pot, potIndex: number, hands: Map<number, HandResult>): Award {
    const candidates = pot.eligibleSeats.filter((seat) => hands.has(seat));
    if (candidates.length === 0) {
      throw new EngineError(`Pot ${potIndex} has no eligible player`);
    }
    const bestScore = Math.max(...candidates.map((seat) => hands.get(seat)?.score ?? -1));
    const tiedWinners = candidates.filter((seat) => hands.get(seat)?.score === bestScore);
    // Odd chips go to the winners closest to the left of the dealer.
    const payoutOrder = seatsClockwiseAfter(this.requireDealerSeat(), tiedWinners);
    const winners = [...splitPot(pot.amount, payoutOrder)].map(([seat, amount]) => ({
      seat,
      amount,
      hand: hands.get(seat) ?? null,
    }));
    return { potIndex, amount: pot.amount, winners };
  }

  // ---------------------------------------------------------------- lookups

  private occupiedSeats(): SeatState[] {
    return this.seats.filter(isOccupied);
  }

  private playersInHand(): SeatState[] {
    return this.occupiedSeats().filter((player) => player.inHand);
  }

  /** Everyone whose chips are in the pot, including folded players who already left the table. */
  private handParticipants(): SeatState[] {
    return [...this.playersInHand(), ...this.departedPlayers];
  }

  private requirePlayer(seat: number): SeatState {
    const player = Number.isInteger(seat) ? this.seats[seat] : null;
    if (!player) {
      throw new EngineError(`Seat ${seat} is empty`);
    }
    return player;
  }

  private requireDealerSeat(): number {
    if (this.dealer === null) {
      throw new EngineError('No hand has been dealt yet');
    }
    return this.dealer;
  }
}
