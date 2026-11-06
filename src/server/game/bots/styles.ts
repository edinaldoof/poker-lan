import type { BotPersonality } from './botTypes';

export const BOT_PERSONALITIES: BotPersonality[] = [
  { name: 'Bia', style: 'Agressiva', aggression: 0.85, looseness: 0.6, bluff: 0.4, skill: 0.7, adaptation: 0.6 },
  { name: 'Caio', style: 'Calculista', aggression: 0.5, looseness: 0.45, bluff: 0.15, skill: 0.85, adaptation: 0.7 },
  { name: 'Duda', style: 'Imprevisível', aggression: 0.55, looseness: 0.65, bluff: 0.55, skill: 0.35, adaptation: 0.4 },
  { name: 'Leo', style: 'Conservador', aggression: 0.25, looseness: 0.15, bluff: 0.05, skill: 0.6, adaptation: 0.3 },
  { name: 'Nina', style: 'Blefadora', aggression: 0.65, looseness: 0.55, bluff: 0.9, skill: 0.85, adaptation: 0.8 },
  { name: 'Otto', style: 'Tubarão', aggression: 0.75, looseness: 0.35, bluff: 0.25, skill: 1, adaptation: 0.9 },
  { name: 'Tati', style: 'Paciente', aggression: 0.35, looseness: 0.3, bluff: 0.06, skill: 0.7, adaptation: 0.5 },
  { name: 'Vini', style: 'Kamikaze', aggression: 0.95, looseness: 0.9, bluff: 0.7, skill: 0.4, adaptation: 0.2 },
];

/** How a personality turns into concrete playing habits. */
export interface BotStyle {
  /** Multiplies the standard opening ranges. */
  readonly openScale: number;
  /** Equity the bot gives up before calling preflop (positive = calls lighter). */
  readonly preflopCallSlack: number;
  /** Equity against the raiser's range needed to re-raise for value. */
  readonly reraiseValueEquity: number;
  /** Chance that a suitable light 3-bet or 4-bet hand actually re-raises when the numbers allow it. */
  readonly reraiseBluffRate: number;
  /** Weight of the population prior when reading opponents: small = adapts fast. */
  readonly priorScale: number;
  /** 0..1: how strongly opponents' actions narrow their ranges. */
  readonly readingSharpness: number;
  readonly simulationIterations: number;
  /** Softmax temperature as a share of the pot: how far the bot drifts from the best-looking play. */
  readonly temperature: number;
  /**
   * Bonus (share of the pot) for value bets, thin value and semi-bluffs: aggressive styles bet and raise them where
   * passive styles check and call.
   */
  readonly aggressionBias: number;
  /**
   * Bonus for pure bluffs. Negative for every sound style, so a bluff needs a real edge and careful styles a bigger
   * one; only the reckless style (very aggressive and unskilled) accepts bluffs that lose a little.
   */
  readonly bluffBias: number;
  /** Chance to even consider a bluff the numbers allow: careful styles pass up most of them. */
  readonly bluffWillingness: number;
  /** Bonus for calling: sticky styles call down lighter. */
  readonly callBias: number;
  /** Chance to slow-play a monster against aggressive opponents. */
  readonly trapRate: number;
  /** How much the bot values floating in position to take the pot away later. */
  readonly floatAppetite: number;
  /** Chance to use the polarised overbet in spots where the bot's range can hold the nuts. */
  readonly overbetRate: number;
  /** Multiplies the standard bet sizes. */
  readonly sizeScale: number;
  /** Random spread of bet sizes inside the menu (the unpredictable style). */
  readonly sizeJitter: number;
}

export function styleOf(personality: BotPersonality): BotStyle {
  const { aggression, looseness, bluff, skill, adaptation } = personality;
  // Skilled players show their style in ranges and frequencies, not in plays that lose chips: their habits weigh less.
  const habitWeight = 1.3 - skill;
  return {
    openScale: 0.7 + 0.75 * looseness,
    preflopCallSlack: 0.16 * (looseness - 0.4),
    reraiseValueEquity: 0.6 - 0.08 * aggression,
    reraiseBluffRate: 0.1 + 0.9 * bluff * aggression,
    priorScale: 1.6 - 1.2 * adaptation,
    readingSharpness: 0.45 + 0.55 * skill,
    simulationIterations: Math.round(300 + 400 * skill),
    temperature: 0.01 + 0.12 * (1 - skill),
    aggressionBias: 0.3 * (aggression - 0.5) * habitWeight,
    bluffBias: recklessness(aggression, skill) - requiredBluffEdge(bluff),
    bluffWillingness: Math.min(1, 0.15 + 3.4 * bluff),
    callBias: 0.05 * (looseness - 0.45) * habitWeight,
    trapRate: 0.05 + 0.3 * (1 - aggression),
    floatAppetite: skill * (0.4 + bluff) * 0.5,
    overbetRate: 0.04 + 0.4 * bluff * skill,
    sizeScale: 0.85 + 0.3 * aggression,
    sizeJitter: 0.25 * (1 - skill) * looseness,
  };
}

/**
 * Edge over checking (share of the pot) a pure bluff must show. The fold model is most optimistic exactly where it
 * picks its bluffs, so even the boldest style keeps a small margin and the break-even bluffs drop out; careful
 * styles demand a clear edge, so their bluffs stay rare.
 */
function requiredBluffEdge(bluff: number): number {
  const neutralBluff = 0.3;
  return 0.004 + 0.015 * (1 - bluff) + 0.25 * Math.max(0, neutralBluff - bluff);
}

/** Kamikaze bluffing: grows with aggression and fades fast with skill, so only wild, unskilled styles show it. */
function recklessness(aggression: number, skill: number): number {
  return 1.5 * Math.max(0, aggression - 0.6) * (1 - skill) ** 3;
}
