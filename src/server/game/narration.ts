import { cardLabel, cardSpeech, type Card } from '../../shared/cards';
import { formatChips } from '../../shared/format';
import type { ActionType, Narration, TableConfig } from '../../shared/protocol';

const STREET_TITLES = { flop: 'Flop', turn: 'Turn', river: 'River' } as const;

export interface AwardNarrationInput {
  amount: number;
  winners: { name: string; amount: number; handName: string | null }[];
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]}`;
}

function formatBlinds(smallBlind: number, bigBlind: number): string {
  return `${formatChips(smallBlind)}/${formatChips(bigBlind)}`;
}

export function narrateHandStart(
  handNumber: number,
  dealerName: string,
  smallBlind: number,
  bigBlind: number,
): Narration {
  return {
    text: `Mão #${handNumber} — Dealer: ${dealerName} · Blinds ${formatBlinds(smallBlind, bigBlind)}`,
    speech: `Mão número ${handNumber}. O dealer é ${dealerName}. Blinds ${formatChips(smallBlind)} e ${formatChips(bigBlind)}.`,
    tone: 'info',
    priority: 1,
  };
}

export function narrateBlind(name: string, amount: number, blind: 'small' | 'big'): Narration {
  const blindName = blind === 'small' ? 'small blind' : 'big blind';
  return { text: `${name} posta o ${blindName} de ${formatChips(amount)}.`, tone: 'action', priority: 2 };
}

export function narrateDeal(): Narration {
  return { text: 'O Juiz distribui as cartas.', tone: 'info', priority: 2 };
}

function narrateTimeout(name: string, action: 'fold' | 'check'): Narration {
  const automaticAction = action === 'check' ? 'check' : 'fold';
  return {
    text: `Tempo esgotado! O Juiz aplica ${automaticAction} automático para ${name}.`,
    tone: 'warn',
    priority: 1,
  };
}

export function narrateAction(
  name: string,
  action: ActionType,
  amount: number,
  totalBet: number,
  timedOut: boolean,
): Narration {
  if (timedOut && (action === 'check' || action === 'fold')) return narrateTimeout(name, action);

  switch (action) {
    case 'fold':
      return { text: `${name} desiste da mão.`, tone: 'action', priority: 2 };
    case 'check':
      return { text: `${name} dá check.`, tone: 'action', priority: 2 };
    case 'call':
      return { text: `${name} paga ${formatChips(amount)}.`, tone: 'action', priority: 2 };
    case 'bet':
      return { text: `${name} aposta ${formatChips(totalBet)}.`, tone: 'action', priority: 1 };
    case 'raise':
      return { text: `${name} aumenta para ${formatChips(totalBet)}.`, tone: 'action', priority: 1 };
    case 'allIn':
      return {
        text: `ALL-IN! ${name} empurra ${formatChips(amount)} fichas!`,
        speech: `All-in! ${name} empurra ${formatChips(amount)} fichas!`,
        tone: 'alert',
        priority: 1,
      };
  }
}

export function narrateStreet(street: 'flop' | 'turn' | 'river', cards: Card[], board: Card[]): Narration {
  const title = STREET_TITLES[street];
  const newCards = cards.map(cardLabel).join(' ');
  const boardSummary = street === 'flop' ? '' : ` · Mesa: ${board.map(cardLabel).join(' ')}`;
  return {
    text: `Cartas na mesa: ${title}! ${newCards}${boardSummary}`,
    speech: `${title}: ${cards.map(cardSpeech).join(', ')}`,
    tone: 'street',
    priority: 1,
  };
}

export function narrateReveal(allIn: boolean): Narration {
  if (allIn) {
    return {
      text: 'Todos em all-in! O Juiz vira as cartas antes de completar a mesa.',
      tone: 'alert',
      priority: 1,
    };
  }
  return { text: 'Hora de mostrar as cartas!', tone: 'street', priority: 1 };
}

export function narrateAward(award: AwardNarrationInput, potLabel: string, showdown: boolean): Narration {
  const amount = formatChips(award.amount);
  const names = joinNames(award.winners.map((winner) => winner.name));
  const handName = award.winners[0]?.handName ?? null;
  const withHand = handName ? ` com ${handName}` : '';

  if (award.winners.length > 1) {
    const labelNote = potLabel === 'pote' ? '' : ` (${potLabel})`;
    return {
      text: `Pote dividido${labelNote}! ${names} dividem ${amount}${withHand}.`,
      tone: 'win',
      priority: 1,
    };
  }

  if (!showdown) {
    return { text: `${names} vence o ${potLabel} de ${amount} sem showdown.`, tone: 'win', priority: 1 };
  }
  return { text: `Showdown! ${names} vence o ${potLabel} de ${amount}${withHand}!`, tone: 'win', priority: 1 };
}

export function narrateJoin(name: string): Narration {
  return { text: `${name} entrou na mesa.`, tone: 'info', priority: 2 };
}

export function narrateSpectator(name: string): Narration {
  return { text: `${name} está assistindo à mesa.`, tone: 'info', priority: 2 };
}

export function narrateLeave(name: string): Narration {
  return { text: `${name} saiu da mesa.`, tone: 'info', priority: 2 };
}

export function narrateDisconnect(name: string): Narration {
  return { text: `${name} perdeu a conexão.`, tone: 'warn', priority: 2 };
}

export function narrateReconnect(name: string): Narration {
  return { text: `${name} voltou à mesa.`, tone: 'info', priority: 2 };
}

export function narrateRebuy(name: string, amount: number): Narration {
  return { text: `${name} recomprou ${formatChips(amount)} fichas.`, tone: 'info', priority: 2 };
}

export function narrateBust(name: string): Narration {
  return { text: `${name} ficou sem fichas.`, tone: 'warn', priority: 1 };
}

export function narrateWaiting(): Narration {
  return { text: 'Aguardando jogadores…', tone: 'info', priority: 2 };
}

export function narrateGameStart(config: TableConfig): Narration {
  const blinds = formatBlinds(config.smallBlind, config.bigBlind);
  return {
    text: `A partida começou! Blinds ${blinds} · Stack inicial ${formatChips(config.startingStack)} · ${config.turnSeconds} s por jogada`,
    speech: `A partida começou! Blinds ${formatChips(config.smallBlind)} e ${formatChips(config.bigBlind)}, com ${formatChips(config.startingStack)} fichas iniciais.`,
    tone: 'info',
    priority: 1,
  };
}
