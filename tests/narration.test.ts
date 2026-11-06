import { describe, expect, it } from 'vitest';
import {
  narrateAction,
  narrateAward,
  narrateBlind,
  narrateBust,
  narrateDeal,
  narrateGameStart,
  narrateHandStart,
  narrateJoin,
  narrateLeave,
  narrateRebuy,
  narrateReveal,
  narrateStreet,
  narrateWaiting,
} from '../src/server/game/narration';

describe('hand start and blinds', () => {
  it('announces the hand number, dealer and blinds with thousand separators', () => {
    const narration = narrateHandStart(12, 'Ana', 10, 20);
    expect(narration.text).toBe('Mão #12 — Dealer: Ana · Blinds 10/20');
    expect(narration.priority).toBe(1);

    expect(narrateHandStart(3, 'Bruno', 1000, 2000).text).toBe('Mão #3 — Dealer: Bruno · Blinds 1.000/2.000');
  });

  it('describes the small and the big blind posts at low priority', () => {
    const small = narrateBlind('Ana', 10, 'small');
    expect(small.text).toBe('Ana posta o small blind de 10.');
    expect(small.priority).toBe(2);
    expect(narrateBlind('Bruno', 2500, 'big').text).toBe('Bruno posta o big blind de 2.500.');
  });

  it('narrates the deal as a low-priority info message', () => {
    expect(narrateDeal()).toMatchObject({ tone: 'info', priority: 2 });
  });
});

describe('player actions', () => {
  it('says raises with the raise-to total', () => {
    const narration = narrateAction('Bruno', 'raise', 280, 300, false);
    expect(narration.text).toBe('Bruno aumenta para 300.');
    expect(narration.priority).toBe(1);
  });

  it('says opening bets with the bet size', () => {
    expect(narrateAction('Ana', 'bet', 100, 100, false).text).toBe('Ana aposta 100.');
  });

  it('says calls with the chips paid now and checks and folds at low priority', () => {
    expect(narrateAction('Ana', 'call', 1250, 1500, false).text).toBe('Ana paga 1.250.');
    expect(narrateAction('Ana', 'check', 0, 0, false)).toMatchObject({ text: 'Ana dá check.', priority: 2 });
    expect(narrateAction('Ana', 'fold', 0, 0, false)).toMatchObject({ text: 'Ana desiste da mão.', priority: 2 });
  });

  it('shouts all-in with the pushed chips as an alert', () => {
    const narration = narrateAction('Carla', 'allIn', 1540, 1540, false);
    expect(narration.text).toBe('ALL-IN! Carla empurra 1.540 fichas!');
    expect(narration.tone).toBe('alert');
    expect(narration.priority).toBe(1);
  });

  it('explains automatic check and fold after a timeout as a warning', () => {
    const check = narrateAction('Davi', 'check', 0, 0, true);
    expect(check.text).toBe('Tempo esgotado! O Juiz aplica check automático para Davi.');
    expect(check.tone).toBe('warn');
    expect(check.priority).toBe(1);

    expect(narrateAction('Davi', 'fold', 0, 0, true).text).toBe(
      'Tempo esgotado! O Juiz aplica fold automático para Davi.',
    );
  });
});

describe('streets and reveals', () => {
  it('writes the flop with card symbols and spells the cards out for the voice', () => {
    const narration = narrateStreet('flop', ['As', 'Kd', '7c'], ['As', 'Kd', '7c']);
    expect(narration.text).toBe('Cartas na mesa: Flop! A♠ K♦ 7♣');
    expect(narration.speech).toBe('Flop: Ás de Espadas, Rei de Ouros, Sete de Paus');
    expect(narration.tone).toBe('street');
    expect(narration.priority).toBe(1);
  });

  it('shows the whole board after the turn and the river', () => {
    const turn = narrateStreet('turn', ['2h'], ['As', 'Kd', '7c', '2h']);
    expect(turn.text).toBe('Cartas na mesa: Turn! 2♥ · Mesa: A♠ K♦ 7♣ 2♥');
    expect(turn.speech).toBe('Turn: Dois de Copas');

    const river = narrateStreet('river', ['Td'], ['As', 'Kd', '7c', '2h', 'Td']);
    expect(river.text).toBe('Cartas na mesa: River! 10♦ · Mesa: A♠ K♦ 7♣ 2♥ 10♦');
    expect(river.speech).toBe('River: Dez de Ouros');
  });

  it('distinguishes the all-in reveal from a regular showdown reveal', () => {
    expect(narrateReveal(true).tone).toBe('alert');
    expect(narrateReveal(true).text).toContain('all-in');
    expect(narrateReveal(false).tone).toBe('street');
  });
});

describe('awards', () => {
  it('announces a single showdown winner with the hand name', () => {
    const narration = narrateAward(
      { amount: 2400, winners: [{ name: 'Bruno', amount: 2400, handName: 'Full House de Ases e Reis' }] },
      'pote',
      true,
    );
    expect(narration.text).toBe('Showdown! Bruno vence o pote de 2.400 com Full House de Ases e Reis!');
    expect(narration.tone).toBe('win');
    expect(narration.priority).toBe(1);
  });

  it('announces a split pot naming every winner', () => {
    const narration = narrateAward(
      {
        amount: 1200,
        winners: [
          { name: 'Ana', amount: 600, handName: 'Sequência até o Dez' },
          { name: 'Bruno', amount: 600, handName: 'Sequência até o Dez' },
        ],
      },
      'pote',
      true,
    );
    expect(narration.text).toBe('Pote dividido! Ana e Bruno dividem 1.200 com Sequência até o Dez.');
  });

  it('lists three winners with commas and a final "e"', () => {
    const narration = narrateAward(
      {
        amount: 900,
        winners: [
          { name: 'Ana', amount: 300, handName: 'Par de Reis' },
          { name: 'Bruno', amount: 300, handName: 'Par de Reis' },
          { name: 'Carla', amount: 300, handName: 'Par de Reis' },
        ],
      },
      'pote',
      true,
    );
    expect(narration.text).toBe('Pote dividido! Ana, Bruno e Carla dividem 900 com Par de Reis.');
  });

  it('announces an uncontested pot without showdown', () => {
    const narration = narrateAward(
      { amount: 300, winners: [{ name: 'Ana', amount: 300, handName: null }] },
      'pote',
      false,
    );
    expect(narration.text).toBe('Ana vence o pote de 300 sem showdown.');
  });

  it('mentions side pots by their label', () => {
    const winner = narrateAward(
      { amount: 500, winners: [{ name: 'Davi', amount: 500, handName: 'Trinca de Noves' }] },
      'side pot 1',
      true,
    );
    expect(winner.text).toBe('Showdown! Davi vence o side pot 1 de 500 com Trinca de Noves!');

    const split = narrateAward(
      {
        amount: 500,
        winners: [
          { name: 'Ana', amount: 250, handName: 'Par de Ases' },
          { name: 'Davi', amount: 250, handName: 'Par de Ases' },
        ],
      },
      'side pot 1',
      true,
    );
    expect(split.text).toBe('Pote dividido (side pot 1)! Ana e Davi dividem 500 com Par de Ases.');
  });
});

describe('table membership messages', () => {
  it('writes join, leave, rebuy, bust and waiting messages in Portuguese', () => {
    expect(narrateJoin('Ana').text).toBe('Ana entrou na mesa.');
    expect(narrateLeave('Ana').text).toBe('Ana saiu da mesa.');
    expect(narrateRebuy('Ana', 2000).text).toBe('Ana recomprou 2.000 fichas.');
    expect(narrateBust('Ana')).toMatchObject({ text: 'Ana ficou sem fichas.', tone: 'warn' });
    expect(narrateWaiting().text).toBe('Aguardando jogadores…');
  });

  it('summarises the table configuration when the game starts', () => {
    const narration = narrateGameStart({ smallBlind: 25, bigBlind: 50, startingStack: 10000, turnSeconds: 30 });
    expect(narration.text).toBe('A partida começou! Blinds 25/50 · Stack inicial 10.000 · 30 s por jogada');
    expect(narration.priority).toBe(1);
  });
});
