import type { Card } from '../../../shared/cards';
import type { LegalActions, Street } from '../../../shared/protocol';
import type { PublicHandView } from './publicInfo';

export interface BotPersonality {
  name: string;
  style: string;
  /** 0..1: how often and how large the bot bets and raises. */
  aggression: number;
  /** 0..1: how wide a range of starting hands and calls the bot accepts. */
  looseness: number;
  /** 0..1: how much the bot likes bluffing lines (it still only bluffs where it expects folds). */
  bluff: number;
  /** 0..1: quality of its reads: hand reading, simulation depth and how little it drifts from the best play. */
  skill: number;
  /** 0..1: how quickly it trusts what it observes about each opponent over its default assumptions. */
  adaptation: number;
}

export interface BotContext {
  holeCards: Card[];
  community: Card[];
  street: Street;
  chips: number;
  streetBet: number;
  currentBet: number;
  /** Total pot including the bets still in front of the players. */
  pot: number;
  legal: LegalActions;
  bigBlind: number;
  /** Opponents still in the hand (not folded), all-in players included. */
  opponents: number;
  personality: BotPersonality;
  /** The hand and the players' history as the whole table saw them; without it the bot plays with no reads. */
  table?: PublicHandView;
}
