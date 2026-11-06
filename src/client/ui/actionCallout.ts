import { formatChips } from '../../shared/format';
import type { ActionType } from '../../shared/protocol';

/** The colour family shared by the table callouts, the last-action pills and the action bar. */
export type ActionTone = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin' | 'blind';

export type CalloutAction = ActionType | 'smallBlind' | 'bigBlind';

export interface ActionCallout {
  tone: ActionTone;
  verb: string;
  /** Chips shown next to the verb; null when the action moves no chips. */
  amount: number | null;
}

/** Calls show the chips just paid; bets, raises and all-ins show the whole bet now in front of the player. */
export function describeAction(action: CalloutAction, amount: number, totalBet: number): ActionCallout {
  switch (action) {
    case 'fold':
      return { tone: 'fold', verb: 'Fold', amount: null };
    case 'check':
      return { tone: 'check', verb: 'Check', amount: null };
    case 'call':
      return { tone: 'call', verb: 'Paga', amount: positiveOrNull(amount) };
    case 'bet':
      return { tone: 'bet', verb: 'Aposta', amount: positiveOrNull(totalBet) };
    case 'raise':
      return { tone: 'raise', verb: 'Aumenta para', amount: positiveOrNull(totalBet) };
    case 'allIn':
      return { tone: 'allin', verb: 'All-in', amount: positiveOrNull(totalBet) };
    case 'smallBlind':
      return { tone: 'blind', verb: 'Small blind', amount: positiveOrNull(amount) };
    case 'bigBlind':
      return { tone: 'blind', verb: 'Big blind', amount: positiveOrNull(amount) };
  }
}

export function calloutText(callout: ActionCallout): string {
  return callout.amount === null ? callout.verb : `${callout.verb} ${formatChips(callout.amount)}`;
}

/** The server sends the persistent last-action pill as a label ("Pagou 40", "Aumentou p/ 300"). */
export function toneOfLastAction(label: string): ActionTone {
  if (label === 'Fold') return 'fold';
  if (label === 'Check') return 'check';
  if (label === 'All-In') return 'allin';
  if (label.startsWith('Pagou')) return 'call';
  if (label.startsWith('Apostou')) return 'bet';
  if (label.startsWith('Aumentou')) return 'raise';
  return 'blind';
}

export function formatLastAction(label: string): string {
  if (label === 'All-In') return 'All-in';
  return label.replace(/\bp\/\s*/, 'para ');
}

function positiveOrNull(amount: number): number | null {
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}
