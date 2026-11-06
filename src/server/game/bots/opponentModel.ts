import type { PlayerStatCounts, PostflopStreet } from './publicInfo';

/** Smoothed read of a player, every value a frequency in 0..1. */
export interface PlayerTendencies {
  vpip: number;
  pfr: number;
  threeBet: number;
  /** Calls a single raise without re-raising. */
  flatCall: number;
  foldToThreeBet: number;
  foldToSteal: number;
  /** Share of the player's postflop actions that are bets or raises. */
  aggression: number;
  cbet: number;
  foldToCbet: number;
  foldToBet: Readonly<Record<PostflopStreet, number>>;
  /** Folds to a turn or river bet after calling a bet on the street before. */
  foldToBetAfterCall: Readonly<Record<StreetAfterCall, number>>;
  /** Folds to a donk or probe bet after making the last bet or raise on the street before. */
  foldToBetWithInitiative: number;
  foldToRaise: number;
  /** Bets the turn again after betting the flop. */
  barrel: number;
  /** Share of the river bets seen at showdown that were bluffs. */
  riverBluffShare: number;
  /** Share of the flop and turn bets seen at showdown that were bluffs without a draw. */
  earlyBluffShare: number;
  /** Share of all bets seen at showdown made with a middling hand: high for players who bet any pair. */
  mediumBetShare: number;
}

export type StreetAfterCall = 'turn' | 'river';

interface Prior {
  readonly rate: number;
  /** How many observations the prior is worth before personality scaling. */
  readonly weight: number;
}

/** A typical LAN home-game player, the read on everybody before they show anything. */
export const POPULATION_PRIORS = {
  vpip: { rate: 0.3, weight: 14 },
  pfr: { rate: 0.17, weight: 14 },
  threeBet: { rate: 0.07, weight: 16 },
  flatCall: { rate: 0.15, weight: 12 },
  foldToThreeBet: { rate: 0.55, weight: 8 },
  foldToSteal: { rate: 0.6, weight: 8 },
  aggression: { rate: 0.3, weight: 16 },
  cbet: { rate: 0.6, weight: 8 },
  foldToCbet: { rate: 0.45, weight: 8 },
  foldToFlopBet: { rate: 0.42, weight: 10 },
  foldToTurnBet: { rate: 0.4, weight: 10 },
  foldToRiverBet: { rate: 0.42, weight: 10 },
  // Players who called the last street hold fewer hands that give up, so they fold less than their overall rate.
  foldToTurnBetAfterCall: { rate: 0.36, weight: 8 },
  foldToRiverBetAfterCall: { rate: 0.36, weight: 8 },
  // The last aggressor holds the stronger range, so a bet into it gets through less often.
  foldToBetWithInitiative: { rate: 0.3, weight: 8 },
  foldToRaise: { rate: 0.5, weight: 8 },
  barrel: { rate: 0.5, weight: 6 },
  riverBluffShare: { rate: 0.3, weight: 6 },
  earlyBluffShare: { rate: 0.25, weight: 8 },
  mediumBetShare: { rate: 0.3, weight: 8 },
} as const satisfies Record<string, Prior>;

/**
 * Blends what was observed with the population prior. `priorScale` is the observer's patience: a bot that adapts
 * fast uses a small scale and trusts a few hands, a stubborn one needs many hands before it changes its read.
 */
export function estimateTendencies(counts: Readonly<PlayerStatCounts> | undefined, priorScale: number): PlayerTendencies {
  const smooth = (successes: number, chances: number, prior: Prior): number => {
    const weight = prior.weight * priorScale;
    return (successes + prior.rate * weight) / (chances + weight);
  };
  const stats = counts ?? null;
  const postflopActions = stats
    ? stats.postflopAggressive + stats.postflopCalls + stats.postflopChecks + stats.postflopFolds
    : 0;
  return {
    vpip: smooth(stats?.vpip ?? 0, stats?.hands ?? 0, POPULATION_PRIORS.vpip),
    pfr: smooth(stats?.pfr ?? 0, stats?.hands ?? 0, POPULATION_PRIORS.pfr),
    threeBet: smooth(stats?.threeBets ?? 0, stats?.threeBetChances ?? 0, POPULATION_PRIORS.threeBet),
    flatCall: smooth(stats?.flatCalls ?? 0, stats?.threeBetChances ?? 0, POPULATION_PRIORS.flatCall),
    foldToThreeBet: smooth(stats?.foldsToThreeBet ?? 0, stats?.foldToThreeBetChances ?? 0, POPULATION_PRIORS.foldToThreeBet),
    foldToSteal: smooth(stats?.foldsToSteal ?? 0, stats?.stealDefenseChances ?? 0, POPULATION_PRIORS.foldToSteal),
    aggression: smooth(stats?.postflopAggressive ?? 0, postflopActions, POPULATION_PRIORS.aggression),
    cbet: smooth(stats?.cbets ?? 0, stats?.cbetChances ?? 0, POPULATION_PRIORS.cbet),
    foldToCbet: smooth(stats?.foldsToCbet ?? 0, stats?.foldToCbetChances ?? 0, POPULATION_PRIORS.foldToCbet),
    foldToBet: {
      flop: smooth(stats?.foldsToBets[0] ?? 0, stats?.facedBets[0] ?? 0, POPULATION_PRIORS.foldToFlopBet),
      turn: smooth(stats?.foldsToBets[1] ?? 0, stats?.facedBets[1] ?? 0, POPULATION_PRIORS.foldToTurnBet),
      river: smooth(stats?.foldsToBets[2] ?? 0, stats?.facedBets[2] ?? 0, POPULATION_PRIORS.foldToRiverBet),
    },
    foldToBetAfterCall: {
      turn: smooth(stats?.foldsToBetsAfterCall[0] ?? 0, stats?.facedBetsAfterCall[0] ?? 0, POPULATION_PRIORS.foldToTurnBetAfterCall),
      river: smooth(stats?.foldsToBetsAfterCall[1] ?? 0, stats?.facedBetsAfterCall[1] ?? 0, POPULATION_PRIORS.foldToRiverBetAfterCall),
    },
    foldToBetWithInitiative: smooth(
      stats?.foldsToBetsWithInitiative ?? 0,
      stats?.facedBetsWithInitiative ?? 0,
      POPULATION_PRIORS.foldToBetWithInitiative,
    ),
    foldToRaise: smooth(stats?.foldsToRaises ?? 0, stats?.facedRaises ?? 0, POPULATION_PRIORS.foldToRaise),
    barrel: smooth(stats?.barrels ?? 0, stats?.barrelChances ?? 0, POPULATION_PRIORS.barrel),
    riverBluffShare: smooth(stats?.shownRiverBluffs ?? 0, stats?.shownRiverBets ?? 0, POPULATION_PRIORS.riverBluffShare),
    earlyBluffShare: smooth(stats?.shownEarlyBluffs ?? 0, stats?.shownEarlyBets ?? 0, POPULATION_PRIORS.earlyBluffShare),
    mediumBetShare: smooth(
      stats?.shownMediumBets ?? 0,
      (stats?.shownEarlyBets ?? 0) + (stats?.shownRiverBets ?? 0),
      POPULATION_PRIORS.mediumBetShare,
    ),
  };
}

export function populationFoldToBet(street: PostflopStreet): number {
  if (street === 'flop') return POPULATION_PRIORS.foldToFlopBet.rate;
  if (street === 'turn') return POPULATION_PRIORS.foldToTurnBet.rate;
  return POPULATION_PRIORS.foldToRiverBet.rate;
}

export function populationFoldToBetAfterCall(street: StreetAfterCall): number {
  return street === 'turn' ? POPULATION_PRIORS.foldToTurnBetAfterCall.rate : POPULATION_PRIORS.foldToRiverBetAfterCall.rate;
}
