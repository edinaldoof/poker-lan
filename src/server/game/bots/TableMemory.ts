import type { Card } from '../../../shared/cards';
import type { ActionType, Street } from '../../../shared/protocol';
import { cardToCode, type CardCode } from './cardCodes';
import { addHandToStats } from './handStats';
import {
  type BettingStreet,
  type PlayerStatCounts,
  type PublicAction,
  type PublicActionKind,
  type PublicHandView,
  type PublicSeat,
  createEmptyStatCounts,
} from './publicInfo';

export interface HandStartFacts {
  readonly buttonSeat: number;
  readonly smallBlindSeat: number;
  readonly bigBlindSeat: number;
  readonly bigBlind: number;
  readonly blinds: readonly { seat: number; amount: number }[];
  /** Players dealt in, clockwise starting with the seat after the button. */
  readonly players: readonly { seat: number; playerId: string }[];
}

export interface ActionFacts {
  readonly seat: number;
  readonly street: Street;
  readonly action: ActionType;
  /** Chips the action moved into the pot. */
  readonly amount: number;
  /** The player's bet on this street after acting. */
  readonly totalBet: number;
}

interface LiveHand {
  readonly start: HandStartFacts;
  readonly actions: PublicAction[];
  readonly shownCards: Map<number, readonly [CardCode, CardCode]>;
  readonly streetBets: Map<number, number>;
  street: BettingStreet;
  pot: number;
  betLevel: number;
  raises: number;
}

/**
 * The table's public memory, shared by every bot: this hand's actions as everybody saw them and per-player
 * statistics from earlier hands. It is fed only with what the table announces (actions, showdowns, the board).
 */
export class BotTableMemory {
  private readonly statsByPlayer = new Map<string, PlayerStatCounts>();
  private hand: LiveHand | null = null;

  beginHand(start: HandStartFacts): void {
    const streetBets = new Map(start.blinds.map((blind) => [blind.seat, blind.amount]));
    this.hand = {
      start,
      actions: [],
      shownCards: new Map(),
      streetBets,
      street: 'preflop',
      pot: start.blinds.reduce((sum, blind) => sum + blind.amount, 0),
      betLevel: start.bigBlind,
      raises: 0,
    };
  }

  recordAction(facts: ActionFacts): void {
    const hand = this.hand;
    if (!hand || !isBettingStreet(facts.street)) return;
    if (facts.street !== hand.street) this.openStreet(hand, facts.street);

    const streetBetBefore = hand.streetBets.get(facts.seat) ?? 0;
    const kind = normalizeKind(facts.action, facts.totalBet, hand.betLevel);
    hand.actions.push({
      seat: facts.seat,
      street: hand.street,
      kind,
      allIn: facts.action === 'allIn',
      chipsAdded: facts.amount,
      totalBet: facts.totalBet,
      potBefore: hand.pot,
      toCall: Math.max(0, hand.betLevel - streetBetBefore),
      betLevelBefore: hand.betLevel,
      raisesBefore: hand.raises,
    });
    hand.pot += facts.amount;
    hand.streetBets.set(facts.seat, facts.totalBet);
    if (facts.totalBet > hand.betLevel) hand.betLevel = facts.totalBet;
    if (kind === 'bet' || kind === 'raise') hand.raises++;
  }

  /** Cards turned face up for the whole table (showdown or all-in runout). */
  recordShowdown(hands: readonly { seat: number; cards: readonly Card[] }[]): void {
    if (!this.hand) return;
    for (const { seat, cards } of hands) {
      if (cards.length === 2) this.hand.shownCards.set(seat, [cardToCode(cards[0]), cardToCode(cards[1])]);
    }
  }

  finishHand(board: readonly Card[], showdown: boolean): void {
    const hand = this.hand;
    this.hand = null;
    if (!hand) return;
    addHandToStats(
      {
        buttonSeat: hand.start.buttonSeat,
        bigBlindSeat: hand.start.bigBlindSeat,
        seatsFromButtonNext: hand.start.players.map((player) => player.seat),
        playerIdBySeat: new Map(hand.start.players.map((player) => [player.seat, player.playerId])),
        actions: hand.actions,
        shownCards: hand.shownCards,
        board: board.map(cardToCode),
        showdown,
      },
      (playerId) => this.statsFor(playerId),
    );
  }

  forgetPlayer(playerId: string): void {
    this.statsByPlayer.delete(playerId);
  }

  reset(): void {
    this.statsByPlayer.clear();
    this.hand = null;
  }

  statsOf(playerId: string): Readonly<PlayerStatCounts> | undefined {
    return this.statsByPlayer.get(playerId);
  }

  /** The hand as `heroSeat` may know it; `seats` must already be stripped to public fields. */
  viewFor(heroSeat: number, seats: readonly PublicSeat[]): PublicHandView | null {
    const hand = this.hand;
    if (!hand) return null;
    const dealtSeats = hand.start.players.map((player) => player.seat);
    const seatsInHand = dealtSeats
      .map((seat) => seats.find((candidate) => candidate.seat === seat))
      .filter((seat): seat is PublicSeat => seat !== undefined);
    if (!seatsInHand.some((seat) => seat.seat === heroSeat)) return null;

    const statsByPlayer: Record<string, PlayerStatCounts> = {};
    for (const { playerId } of hand.start.players) {
      const stats = this.statsByPlayer.get(playerId);
      if (stats) statsByPlayer[playerId] = copyStats(stats);
    }
    return {
      heroSeat,
      buttonSeat: hand.start.buttonSeat,
      smallBlindSeat: hand.start.smallBlindSeat,
      bigBlindSeat: hand.start.bigBlindSeat,
      seats: seatsInHand,
      actions: [...hand.actions],
      statsByPlayer,
    };
  }

  private openStreet(hand: LiveHand, street: BettingStreet): void {
    hand.street = street;
    hand.streetBets.clear();
    hand.betLevel = 0;
    hand.raises = 0;
  }

  private statsFor(playerId: string): PlayerStatCounts {
    let stats = this.statsByPlayer.get(playerId);
    if (!stats) {
      stats = createEmptyStatCounts();
      this.statsByPlayer.set(playerId, stats);
    }
    return stats;
  }
}

function isBettingStreet(street: Street): street is BettingStreet {
  return street === 'preflop' || street === 'flop' || street === 'turn' || street === 'river';
}

function normalizeKind(action: ActionType, totalBet: number, betLevel: number): PublicActionKind {
  if (action !== 'allIn') return action;
  if (totalBet <= betLevel) return 'call';
  return betLevel === 0 ? 'bet' : 'raise';
}

function copyStats(stats: PlayerStatCounts): PlayerStatCounts {
  return {
    ...stats,
    facedBets: [...stats.facedBets],
    foldsToBets: [...stats.foldsToBets],
    facedBetsAfterCall: [...stats.facedBetsAfterCall],
    foldsToBetsAfterCall: [...stats.foldsToBetsAfterCall],
  };
}
