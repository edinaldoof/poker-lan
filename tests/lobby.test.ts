import { describe, expect, it } from 'vitest';
import { PLAYER_COLORS } from '../src/shared/protocol';
import { chipNameFontSize, chipStripeColor, describeInviteLabel, describeTableStatus, relativeLuminance } from '../src/client/ui/Lobby';
import { sliderFillPercent } from '../src/client/ui/menuKit';

describe('lobby table status', () => {
  it('says nothing until the server has reported the table', () => {
    expect(describeTableStatus(null)).toBe('');
  });

  it('describes a game in progress with its hand number', () => {
    expect(describeTableStatus({ seated: 3, maxSeats: 8, running: true, handNumber: 12 })).toBe('3 de 8 lugares ocupados, partida em andamento, mão 12');
    expect(describeTableStatus({ seated: 3, maxSeats: 8, running: true, handNumber: 0 })).toBe('3 de 8 lugares ocupados, partida em andamento');
  });

  it('describes a table that has not started yet', () => {
    expect(describeTableStatus({ seated: 2, maxSeats: 8, running: false, handNumber: 0 })).toBe('2 de 8 lugares ocupados, partida ainda não começou');
  });

  it('invites the first player of an empty table', () => {
    expect(describeTableStatus({ seated: 0, maxSeats: 8, running: false, handNumber: 0 })).toBe('Mesa vazia. Você será o primeiro a sentar.');
  });

  it('warns that a full table only takes spectators', () => {
    expect(describeTableStatus({ seated: 8, maxSeats: 8, running: true, handNumber: 5 })).toContain('espectador');
  });
});

describe('invite label', () => {
  it('counts the addresses only when there is more than one', () => {
    expect(describeInviteLabel(1)).toBe('Chamar amigos');
    expect(describeInviteLabel(4)).toBe('Chamar amigos (4 endereços)');
  });
});

describe('player chip', () => {
  it('shrinks the engraved name so 16 characters still fit on the rim', () => {
    expect(chipNameFontSize(1)).toBe(24);
    expect(chipNameFontSize(8)).toBeLessThanOrEqual(24);
    expect(chipNameFontSize(16)).toBeLessThan(chipNameFontSize(8));
    expect(chipNameFontSize(40)).toBe(15);
    expect(chipNameFontSize(0)).toBe(24);
  });

  it('measures luminance from black to white and tolerates colours it cannot read', () => {
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
    expect(relativeLuminance('not a colour')).toBe(0.5);
  });

  it('draws dark stripes only on the near-white chip colour', () => {
    const darkStripeColors = PLAYER_COLORS.filter((color) => chipStripeColor(color) === '#1a120d');

    expect(darkStripeColors).toEqual(['#f2f2f2']);
  });
});

describe('slider fill', () => {
  it('maps the value onto the track and clamps it', () => {
    expect(sliderFillPercent(50, 0, 100)).toBe(50);
    expect(sliderFillPercent(1.25, 0.5, 2)).toBeCloseTo(50, 5);
    expect(sliderFillPercent(-5, 0, 100)).toBe(0);
    expect(sliderFillPercent(500, 0, 100)).toBe(100);
    expect(sliderFillPercent(3, 5, 5)).toBe(0);
  });
});
