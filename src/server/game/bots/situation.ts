import type { BotContext } from './botTypes';
import { type CardCode, cardToCode } from './cardCodes';
import type { RangeReader } from './handReading';
import { type PlayerTendencies, estimateTendencies } from './opponentModel';
import { type SeatPosition, assignPositions } from './positions';
import type { BettingStreet, PublicAction, PublicHandView, PublicSeat } from './publicInfo';
import { type BotStyle, styleOf } from './styles';

/** Everything one decision needs, derived once from the public context. */
export interface Situation {
  readonly context: BotContext;
  readonly style: BotStyle;
  readonly hole: readonly [CardCode, CardCode];
  readonly board: readonly CardCode[];
  readonly street: BettingStreet;
  readonly view: PublicHandView;
  readonly heroSeat: number;
  readonly positions: ReadonlyMap<number, SeatPosition>;
  readonly liveOpponents: readonly PublicSeat[];
  readonly tendenciesOf: (seat: number) => PlayerTendencies;
  readonly reader: RangeReader;
  /** True when the hero acts after every live opponent on the flop, turn and river. */
  readonly heroInPosition: boolean;
  readonly random: () => number;
}

const UNKNOWN_SEAT_POSITION: SeatPosition = { name: 'hijack', postflopOrder: 0 };

export function buildSituation(context: BotContext, street: BettingStreet, random: () => number): Situation {
  const style = styleOf(context.personality);
  const usable = context.table && context.table.seats.some((seat) => seat.seat === context.table!.heroSeat);
  const { view, positions } = usable ? fromRealView(context.table!) : synthesizeView(context, street);

  const tendencyCache = new Map<number, PlayerTendencies>();
  const playerIdBySeat = new Map(view.seats.map((seat) => [seat.seat, seat.playerId]));
  const tendenciesOf = (seat: number): PlayerTendencies => {
    let tendencies = tendencyCache.get(seat);
    if (!tendencies) {
      const playerId = playerIdBySeat.get(seat);
      tendencies = estimateTendencies(playerId ? view.statsByPlayer[playerId] : undefined, style.priorScale);
      tendencyCache.set(seat, tendencies);
    }
    return tendencies;
  };

  const board = context.community.map(cardToCode);
  const liveOpponents = view.seats.filter((seat) => seat.seat !== view.heroSeat && !seat.folded);
  const heroOrder = (positions.get(view.heroSeat) ?? UNKNOWN_SEAT_POSITION).postflopOrder;
  return {
    context,
    style,
    hole: [cardToCode(context.holeCards[0]), cardToCode(context.holeCards[1])],
    board,
    street,
    view,
    heroSeat: view.heroSeat,
    positions,
    liveOpponents,
    tendenciesOf,
    reader: {
      board,
      positionOf: (seat) => (positions.get(seat) ?? UNKNOWN_SEAT_POSITION).name,
      tendenciesOf,
      sharpness: style.readingSharpness,
    },
    heroInPosition: liveOpponents.every((seat) => (positions.get(seat.seat)?.postflopOrder ?? 0) < heroOrder),
    random,
  };
}

function fromRealView(view: PublicHandView): { view: PublicHandView; positions: Map<number, SeatPosition> } {
  const order = view.seats.map((seat) => seat.seat);
  return { view, positions: assignPositions(order, view.buttonSeat, view.bigBlindSeat) };
}

const HERO_SEAT = 0;
const ANONYMOUS_OPEN_IN_BIG_BLINDS = 3;

/**
 * Without a table view (tests, or a bot asked out of context) the bot imagines the most ordinary story that fits
 * the bets in front of it: anonymous opponents with population habits, the hero out of position.
 */
function synthesizeView(
  context: BotContext,
  street: BettingStreet,
): { view: PublicHandView; positions: Map<number, SeatPosition> } {
  const opponentCount = Math.min(7, Math.max(1, Math.floor(context.opponents)));
  const seats: PublicSeat[] = [
    { seat: HERO_SEAT, playerId: 'hero', chips: context.chips, streetBet: context.streetBet, folded: false, allIn: false },
  ];
  const positions = new Map<number, SeatPosition>([[HERO_SEAT, UNKNOWN_SEAT_POSITION]]);
  for (let index = 1; index <= opponentCount; index++) {
    const streetBet = index === 1 ? context.currentBet : 0;
    seats.push({ seat: index, playerId: `opponent-${index}`, chips: context.chips, streetBet, folded: false, allIn: false });
    positions.set(index, { name: index === 1 ? 'cutoff' : 'button', postflopOrder: index });
  }
  const view: PublicHandView = {
    heroSeat: HERO_SEAT,
    buttonSeat: opponentCount,
    smallBlindSeat: HERO_SEAT,
    bigBlindSeat: HERO_SEAT,
    seats,
    actions: synthesizeActions(context, street, opponentCount),
    statsByPlayer: {},
  };
  return { view, positions };
}

function synthesizeActions(context: BotContext, street: BettingStreet, opponentCount: number): PublicAction[] {
  const { bigBlind, currentBet, streetBet, pot } = context;
  const actions: PublicAction[] = [];
  const facingBet = currentBet > streetBet;
  if (street === 'preflop') {
    if (currentBet > bigBlind) {
      const heroRaisedFirst = streetBet > bigBlind;
      if (heroRaisedFirst) actions.push(syntheticAction(HERO_SEAT, 'preflop', 'raise', streetBet, bigBlind, 0, bigBlind * 1.5));
      actions.push(syntheticAction(1, 'preflop', 'raise', currentBet, heroRaisedFirst ? streetBet : bigBlind, heroRaisedFirst ? 1 : 0, pot - currentBet));
    }
    return actions;
  }
  const open = bigBlind * ANONYMOUS_OPEN_IN_BIG_BLINDS;
  actions.push(syntheticAction(HERO_SEAT, 'preflop', 'raise', open, bigBlind, 0, bigBlind * 1.5));
  for (let seat = 1; seat <= opponentCount; seat++) {
    actions.push(syntheticAction(seat, 'preflop', 'call', open, open, 1, bigBlind * 1.5 + open * seat));
  }
  if (facingBet) {
    const heroBetFirst = streetBet > 0;
    if (heroBetFirst) actions.push(syntheticAction(HERO_SEAT, street, 'bet', streetBet, 0, 0, pot - currentBet - streetBet));
    actions.push(syntheticAction(1, street, heroBetFirst ? 'raise' : 'bet', currentBet, heroBetFirst ? streetBet : 0, heroBetFirst ? 1 : 0, pot - currentBet));
  }
  return actions;
}

function syntheticAction(
  seat: number,
  street: BettingStreet,
  kind: 'bet' | 'raise' | 'call',
  totalBet: number,
  betLevelBefore: number,
  raisesBefore: number,
  potBefore: number,
): PublicAction {
  return {
    seat,
    street,
    kind,
    allIn: false,
    chipsAdded: totalBet,
    totalBet,
    potBefore: Math.max(0, potBefore),
    toCall: betLevelBefore,
    betLevelBefore,
    raisesBefore,
  };
}
