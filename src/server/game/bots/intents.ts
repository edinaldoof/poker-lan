import type { LegalActions, PlayerActionRequest } from '../../../shared/protocol';

type BlockedFallback = 'passive' | 'giveUp';

/** What the bot wants to do, before it is fitted to the actions that are legal right now. */
export type Intent =
  | { readonly kind: 'passive' }
  | { readonly kind: 'giveUp' }
  | { readonly kind: 'raise'; readonly raiseTo: number; readonly ifBlocked: BlockedFallback };

export const PASSIVE: Intent = { kind: 'passive' };
export const GIVE_UP: Intent = { kind: 'giveUp' };

export function raiseIntent(raiseTo: number, ifBlocked: BlockedFallback): Intent {
  return { kind: 'raise', raiseTo, ifBlocked };
}

/** A raise that would put more than this share of the remaining stack in becomes an all-in. */
const ALL_IN_COMMITMENT = 0.7;

export interface StackFacts {
  readonly legal: LegalActions;
  readonly chips: number;
  readonly streetBet: number;
  readonly bigBlind: number;
}

/** Always legal for `facts.legal`; never folds when checking is free. */
export function resolveIntent(intent: Intent, facts: StackFacts): PlayerActionRequest {
  switch (intent.kind) {
    case 'passive':
      return passiveRequest(facts.legal);
    case 'giveUp':
      return giveUpRequest(facts.legal);
    case 'raise':
      if (!canRaiseNow(facts.legal)) {
        return intent.ifBlocked === 'passive' ? passiveRequest(facts.legal) : giveUpRequest(facts.legal);
      }
      return buildRaise(facts, intent.raiseTo);
  }
}

export function canRaiseNow(legal: LegalActions): boolean {
  return legal.canRaise && legal.maxRaiseTo >= legal.minRaiseTo;
}

export function passiveRequest(legal: LegalActions): PlayerActionRequest {
  if (legal.canCheck) return { type: 'check' };
  if (legal.canCall) return { type: 'call' };
  return lastResortRequest(legal);
}

function giveUpRequest(legal: LegalActions): PlayerActionRequest {
  if (legal.canCheck) return { type: 'check' };
  if (legal.canFold) return { type: 'fold' };
  return passiveRequest(legal);
}

function lastResortRequest(legal: LegalActions): PlayerActionRequest {
  if (legal.canFold) return { type: 'fold' };
  if (canRaiseNow(legal)) return { type: 'raise', amount: legal.minRaiseTo };
  return { type: 'check' };
}

function buildRaise(facts: StackFacts, desiredRaiseTo: number): PlayerActionRequest {
  const { legal, chips, streetBet } = facts;
  const raiseTo = tidyRaiseTo(desiredRaiseTo, facts);
  const commitsMostOfStack = raiseTo - streetBet > ALL_IN_COMMITMENT * chips;
  if (raiseTo >= legal.maxRaiseTo || commitsMostOfStack) return { type: 'allIn' };
  return { type: 'raise', amount: raiseTo };
}

function tidyRaiseTo(desiredRaiseTo: number, facts: StackFacts): number {
  // Rounding to half a big blind keeps the sizes looking like a person's bets.
  const step = Math.max(1, Math.floor(facts.bigBlind / 2));
  const tidy = Math.round(desiredRaiseTo / step) * step;
  return Math.min(facts.legal.maxRaiseTo, Math.max(facts.legal.minRaiseTo, Number.isFinite(tidy) ? tidy : 0));
}
