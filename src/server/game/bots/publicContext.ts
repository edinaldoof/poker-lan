import type { Card } from '../../../shared/cards';
import type { ActionType, LegalActions, Street } from '../../../shared/protocol';
import type { BotContext, BotPersonality } from './botTypes';
import type { PublicSeat } from './publicInfo';
import type { ActionFacts, BotTableMemory, HandStartFacts } from './TableMemory';

/** What any player can see of a seat; the engine's richer state is narrowed to this before a bot reads it. */
export interface PublicSeatSource {
  readonly seat: number;
  readonly playerId: string;
  readonly chips: number;
  readonly streetBet: number;
  readonly folded: boolean;
  readonly allIn: boolean;
  readonly inHand: boolean;
}

/** The read-only slice of the table engine needed to brief a bot (the engine satisfies it structurally). */
export interface BotTableSource {
  getPlayer(seat: number): { readonly holeCards: readonly Card[]; readonly chips: number; readonly streetBet: number } | null;
  getPlayers(): readonly PublicSeatSource[];
  readonly community: Card[];
  readonly street: Street;
  readonly currentBet: number;
  totalPot(): number;
  nonFoldedSeats(): number[];
}

/** Copies only public fields: hole cards cannot travel through a PublicSeat. */
export function toPublicSeat(player: PublicSeatSource): PublicSeat {
  return {
    seat: player.seat,
    playerId: player.playerId,
    chips: player.chips,
    streetBet: player.streetBet,
    folded: player.folded,
    allIn: player.allIn,
  };
}

/**
 * The bot's whole briefing: its own hole cards plus public facts. Other players' cards, the deck and the engine
 * itself never reach the bot brain.
 */
export function buildBotContext(
  source: BotTableSource,
  seat: number,
  personality: BotPersonality,
  legal: LegalActions,
  bigBlind: number,
  memory: BotTableMemory,
): BotContext | null {
  const player = source.getPlayer(seat);
  if (!player) return null;
  const publicSeats = source
    .getPlayers()
    .filter((candidate) => candidate.inHand)
    .map(toPublicSeat);
  return {
    holeCards: [...player.holeCards],
    community: [...source.community],
    street: source.street,
    chips: player.chips,
    streetBet: player.streetBet,
    currentBet: source.currentBet,
    pot: source.totalPot(),
    legal,
    bigBlind,
    opponents: Math.max(1, source.nonFoldedSeats().length - 1),
    personality,
    table: memory.viewFor(seat, publicSeats) ?? undefined,
  };
}

export interface HandStartSource {
  readonly dealerSeat: number;
  readonly smallBlindSeat: number;
  readonly bigBlindSeat: number;
  readonly blinds: readonly { seat: number; amount: number }[];
  /** Seats dealt in, clockwise from the seat after the dealer. */
  readonly dealOrder: readonly number[];
}

export function describeHandStart(
  start: HandStartSource,
  playerIdOf: (seat: number) => string | undefined,
  bigBlind: number,
): HandStartFacts {
  return {
    buttonSeat: start.dealerSeat,
    smallBlindSeat: start.smallBlindSeat,
    bigBlindSeat: start.bigBlindSeat,
    bigBlind,
    blinds: start.blinds.map((blind) => ({ seat: blind.seat, amount: blind.amount })),
    players: start.dealOrder
      .map((seat) => ({ seat, playerId: playerIdOf(seat) }))
      .filter((player): player is { seat: number; playerId: string } => player.playerId !== undefined),
  };
}

export function actionFactsOf(
  street: Street,
  result: { seat: number; action: ActionType; amount: number; totalBet: number },
): ActionFacts {
  return { seat: result.seat, street, action: result.action, amount: result.amount, totalBet: result.totalBet };
}
