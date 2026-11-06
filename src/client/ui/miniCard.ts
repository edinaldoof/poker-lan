import { cardLabel, type Card } from '../../shared/cards';
import { CARD_ATLAS_URL, cardBackgroundPosition } from '../manual/manualContent';
import { el } from './dom';
import './menuKit.css';

export interface MiniCardOptions {
  /** Card width in CSS pixels; the height follows the atlas aspect ratio. */
  width?: number;
  /** Cards that are on the table but not part of the winning five are drawn dimmed. */
  dimmed?: boolean;
}

let atlasWarmUp: Promise<void> | null = null;

/** The atlas is 3328 x 1800: decoding it ahead of time keeps the first mini cards from filling in band by band. */
export function warmCardAtlas(): Promise<void> {
  if (atlasWarmUp === null) {
    const atlas = new Image();
    atlas.src = CARD_ATLAS_URL;
    atlasWarmUp = atlas.decode().catch(() => undefined);
  }
  return atlasWarmUp;
}

/** A playing card cut out of the shared atlas, the same art the 3D table uses. */
export function createMiniCard(card: Card | 'back', options: MiniCardOptions = {}): HTMLElement {
  const label = card === 'back' ? 'Carta virada' : cardLabel(card);
  const element = el('span', {
    className: options.dimmed ? 'mini-card mini-card--dim' : 'mini-card',
    attrs: { role: 'img', 'aria-label': label },
    style: { 'background-image': `url("${CARD_ATLAS_URL}")`, 'background-position': cardBackgroundPosition(card) },
  });
  if (options.width !== undefined) element.style.setProperty('--mini-w', `${options.width}px`);
  return element;
}

export function createMiniCards(cards: readonly Card[], options: MiniCardOptions = {}): HTMLElement {
  const group = el('span', { className: 'mini-cards', attrs: { role: 'group' } });
  for (const card of cards) group.appendChild(createMiniCard(card, options));
  return group;
}
