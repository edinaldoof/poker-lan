import { describe, expect, it } from 'vitest';
import { calloutText, describeAction, formatLastAction, toneOfLastAction } from '../src/client/ui/actionCallout';

describe('table callouts', () => {
  it('say fold and check without an amount', () => {
    expect(describeAction('fold', 0, 0)).toEqual({ tone: 'fold', verb: 'Fold', amount: null });
    expect(describeAction('check', 0, 0)).toEqual({ tone: 'check', verb: 'Check', amount: null });
  });

  it('show the chips just paid for a call, not the whole bet', () => {
    const callout = describeAction('call', 40, 60);

    expect(callout).toEqual({ tone: 'call', verb: 'Paga', amount: 40 });
    expect(calloutText(callout)).toBe('Paga 40');
  });

  it('show the whole bet in front of the player for bets, raises and all-ins', () => {
    expect(calloutText(describeAction('bet', 120, 120))).toBe('Aposta 120');
    expect(calloutText(describeAction('raise', 280, 300))).toBe('Aumenta para 300');
    expect(calloutText(describeAction('allIn', 900, 1540))).toBe('All-in 1.540');
  });

  it('name the blinds and show the posted amount', () => {
    expect(calloutText(describeAction('smallBlind', 10, 10))).toBe('Small blind 10');
    expect(calloutText(describeAction('bigBlind', 20, 20))).toBe('Big blind 20');
    expect(describeAction('bigBlind', 20, 20).tone).toBe('blind');
  });

  it('drop the amount when no chips moved', () => {
    expect(describeAction('call', 0, 0).amount).toBeNull();
    expect(describeAction('allIn', 0, Number.NaN).amount).toBeNull();
  });

  it('give each betting action its own colour family', () => {
    const tones = (['fold', 'check', 'call', 'bet', 'raise', 'allIn'] as const).map((action) => describeAction(action, 10, 10).tone);

    expect(new Set(tones).size).toBe(6);
  });
});

describe('last-action pills', () => {
  it('pick the colour family from the label the server sends', () => {
    expect(toneOfLastAction('Fold')).toBe('fold');
    expect(toneOfLastAction('Check')).toBe('check');
    expect(toneOfLastAction('Pagou 40')).toBe('call');
    expect(toneOfLastAction('Apostou 100')).toBe('bet');
    expect(toneOfLastAction('Aumentou p/ 300')).toBe('raise');
    expect(toneOfLastAction('All-In')).toBe('allin');
    expect(toneOfLastAction('SB')).toBe('blind');
    expect(toneOfLastAction('BB')).toBe('blind');
  });

  it('spell out the abbreviations in the label', () => {
    expect(formatLastAction('Aumentou p/ 1.540')).toBe('Aumentou para 1.540');
    expect(formatLastAction('All-In')).toBe('All-in');
    expect(formatLastAction('Pagou 40')).toBe('Pagou 40');
  });
});
