import {
  CLASS_NAMES,
  COMBO_CLASS,
  COMBO_COUNT,
  type CardCode,
  HAND_CLASS_COUNT,
  classIndexOfName,
  combosInClass,
  comboIndexOf,
} from './cardCodes';

/**
 * The 169 starting hands from best to worst. Generated offline from Monte-Carlo equity against one and against three
 * random hands (half each, so multiway playability counts), plus a small bonus for suited and connected hands.
 */
const PREFLOP_ORDER =
  'AA KK QQ JJ TT AKs 99 AQs 88 KQs AJs KJs ATs AKo 77 KTs QJs A9s AQo QTs A8s AJo KQo JTs A7s 66 KJo K9s A5s A6s ' +
  'ATo A4s KTo Q9s K8s J9s QJo K7s A3s 55 T9s QTo A2s Q8s K6s A9o K5s A8o JTo J8s K9o K4s Q7s T8s Q9o 98s A7o Q6s ' +
  'K3s 44 K2s J7s A6o Q5s J9o A5o K8o T7s A4o Q4s 97s K7o T9o 87s A3o J6s Q8o J5s Q3s T6s 33 K6o A2o Q2s J8o K5o ' +
  'J4s 76s 86s 96s T8o 98o K4o J3s Q7o T5s K3o 22 95s 75s Q6o 65s T4s J2s J7o T7o 85s Q5o K2o T3s 97o Q4o 54s T2s ' +
  '87o 94s 84s 64s J6o Q3o 93s 74s Q2o 53s 96o J5o 86o 92s T6o 76o J4o 43s 83s 73s 82s 63s J3o 75o J2o T5o 85o ' +
  '52s 95o 42s 65o T4o 62s 72s T3o 32s 54o T2o 74o 64o 94o 84o 93o 53o 63o 92o 43o 83o 73o 82o 52o 42o 62o 72o 32o';

/** Share of all combos that rank above the middle of each class: 0 = aces, close to 1 = seven-deuce and worse. */
const CLASS_PERCENTILE = new Float32Array(HAND_CLASS_COUNT);
{
  const order = PREFLOP_ORDER.split(' ');
  if (order.length !== HAND_CLASS_COUNT) throw new Error(`Preflop order lists ${order.length} hands`);
  let combosAbove = 0;
  for (const name of order) {
    const combos = combosInClass(name);
    CLASS_PERCENTILE[classIndexOfName(name)] = (combosAbove + combos / 2) / COMBO_COUNT;
    combosAbove += combos;
  }
}

export const COMBO_PREFLOP_PERCENTILE = new Float32Array(COMBO_COUNT);
for (let combo = 0; combo < COMBO_COUNT; combo++) {
  COMBO_PREFLOP_PERCENTILE[combo] = CLASS_PERCENTILE[COMBO_CLASS[combo]];
}

export function preflopPercentile(first: CardCode, second: CardCode): number {
  return COMBO_PREFLOP_PERCENTILE[comboIndexOf(first, second)];
}

const RANK_LETTERS = '23456789TJQKA';

function classShape(name: string): { high: number; low: number; suited: boolean; pair: boolean } {
  const high = RANK_LETTERS.indexOf(name[0]);
  const low = RANK_LETTERS.indexOf(name[1]);
  return { high, low, suited: name.endsWith('s'), pair: high === low };
}

/** Hands that play well as light 3-bets and 4-bets: they block strong aces or flop well when called. */
const RERAISE_BLUFF_CLASS = new Uint8Array(HAND_CLASS_COUNT);
/** Pairs and suited hands that win big pots when they hit (sets, flushes, straights). */
const SPECULATIVE_CLASS = new Uint8Array(HAND_CLASS_COUNT);
CLASS_NAMES.forEach((name, index) => {
  const { high, low, suited, pair } = classShape(name);
  const ace = RANK_LETTERS.indexOf('A');
  const gap = high - low - 1;
  const wheelAce = suited && high === ace && low <= RANK_LETTERS.indexOf('5');
  const suitedConnector = suited && gap <= 1 && low >= RANK_LETTERS.indexOf('4') && high <= RANK_LETTERS.indexOf('J');
  const suitedKing = suited && high === RANK_LETTERS.indexOf('K') && low >= RANK_LETTERS.indexOf('8') && low <= RANK_LETTERS.indexOf('T');
  RERAISE_BLUFF_CLASS[index] = wheelAce || suitedConnector || suitedKing ? 1 : 0;
  SPECULATIVE_CLASS[index] = pair || suitedConnector || (suited && high === ace) ? 1 : 0;
});

export function isReraiseBluffCandidate(first: CardCode, second: CardCode): boolean {
  return RERAISE_BLUFF_CLASS[COMBO_CLASS[comboIndexOf(first, second)]] === 1;
}

export function isSpeculativeHand(first: CardCode, second: CardCode): boolean {
  return SPECULATIVE_CLASS[COMBO_CLASS[comboIndexOf(first, second)]] === 1;
}

export function isPocketPair(first: CardCode, second: CardCode): boolean {
  return first >> 2 === second >> 2;
}

export const COMBO_IS_RERAISE_BLUFF = new Uint8Array(COMBO_COUNT);
for (let combo = 0; combo < COMBO_COUNT; combo++) {
  COMBO_IS_RERAISE_BLUFF[combo] = RERAISE_BLUFF_CLASS[COMBO_CLASS[combo]];
}
