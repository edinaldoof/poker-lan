import './judgePanel.css';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { Object3D } from 'three';
import type { Narration } from '../../shared/protocol';
import { el, restartAnimation, setData, setHidden, setText } from './dom';
import { createToneIcon } from './hudIcons';

const BUBBLE_VISIBLE_MS = 3500;
const BUBBLE_FADE_MS = 220;
const TONE_ICON_SIZE = 16;
/** Space the bubble keeps from the screen edges. */
const EDGE_MARGIN_PX = 8;
/** Distance from the anchor to the bubble, tail included, for each placement. */
const ABOVE_GAP_PX = 14;
const SIDE_OFFSET_PX = 52;
/** The anchor floats above the head; side bubbles are centred this far below it, level with the face. */
const SIDE_DROP_PX = 36;

export type BubblePlacement = 'above' | 'right' | 'left';

export interface PlacementInput {
  /** Where the anchor lands on screen, in CSS pixels. */
  anchor: { x: number; y: number };
  bubble: { width: number; height: number };
  viewport: { width: number; height: number };
}

/**
 * The bubble sits above the dealer's head when there is room; the camera frames the dealer tightly at the
 * top of the screen, so otherwise it moves beside the head, on the side with more space.
 */
export function chooseBubblePlacement({ anchor, bubble, viewport }: PlacementInput): BubblePlacement {
  const fitsAbove =
    anchor.y - ABOVE_GAP_PX - bubble.height >= EDGE_MARGIN_PX &&
    anchor.x - bubble.width / 2 >= EDGE_MARGIN_PX &&
    anchor.x + bubble.width / 2 <= viewport.width - EDGE_MARGIN_PX;
  if (fitsAbove) return 'above';
  const roomRight = viewport.width - EDGE_MARGIN_PX - (anchor.x + SIDE_OFFSET_PX);
  const roomLeft = anchor.x - SIDE_OFFSET_PX - EDGE_MARGIN_PX;
  if (roomRight >= bubble.width || roomRight >= roomLeft) return 'right';
  return 'left';
}

/** How far a side bubble must move down so it does not leave the top of the screen. */
export function sideNudgePx(anchorY: number, bubbleHeight: number): number {
  const top = anchorY + SIDE_DROP_PX - bubbleHeight / 2;
  return Math.max(0, EDGE_MARGIN_PX - top);
}

/** Speech bubble by the dealer's head that repeats the Judge's latest line for a few seconds. */
export class DealerBubble {
  private readonly object: CSS2DObject;
  private readonly anchorElement: HTMLElement;
  private readonly bubble: HTMLElement;
  private readonly iconSlot: HTMLElement;
  private readonly text: HTMLElement;
  private hideTimer: number | null = null;
  private removeTimer: number | null = null;

  constructor(private readonly anchor: Object3D) {
    this.iconSlot = el('span', { className: 'dealer-bubble__icon' });
    this.text = el('span', { className: 'dealer-bubble__text' });
    // The Judge panel already announces every line, so the bubble stays out of the accessibility tree.
    this.bubble = el('div', { className: 'dealer-bubble', attrs: { 'aria-hidden': 'true' }, dataset: { placement: 'above' } }, this.iconSlot, this.text);
    setHidden(this.bubble, true);
    this.bubble.style.setProperty('--bubble-above-gap', `${ABOVE_GAP_PX}px`);
    this.bubble.style.setProperty('--bubble-side-offset', `${SIDE_OFFSET_PX}px`);
    this.bubble.style.setProperty('--bubble-side-drop', `${SIDE_DROP_PX}px`);
    this.anchorElement = el('div', { className: 'dealer-bubble-anchor' }, this.bubble);
    this.object = new CSS2DObject(this.anchorElement);
    this.anchor.add(this.object);
  }

  say(narration: Narration): void {
    this.cancelTimers();
    setText(this.text, narration.text);
    setData(this.bubble, 'tone', narration.tone);
    this.iconSlot.replaceChildren(createToneIcon(narration.tone, TONE_ICON_SIZE));
    this.bubble.classList.remove('is-leaving');
    setHidden(this.bubble, false);
    this.place();
    restartAnimation(this.bubble, 'is-popping');
    this.hideTimer = window.setTimeout(() => this.fadeOut(), BUBBLE_VISIBLE_MS);
  }

  clear(): void {
    this.cancelTimers();
    this.bubble.classList.remove('is-leaving', 'is-popping');
    setHidden(this.bubble, true);
  }

  dispose(): void {
    this.clear();
    this.anchor.remove(this.object);
  }

  private place(): void {
    const anchorBox = this.anchorElement.getBoundingClientRect();
    const size = { width: this.bubble.offsetWidth, height: this.bubble.offsetHeight };
    const placement = chooseBubblePlacement({
      anchor: { x: anchorBox.left, y: anchorBox.top },
      bubble: size,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });
    setData(this.bubble, 'placement', placement);
    const nudge = placement === 'above' ? 0 : sideNudgePx(anchorBox.top, size.height);
    this.bubble.style.setProperty('--bubble-nudge', `${nudge}px`);
  }

  private fadeOut(): void {
    this.hideTimer = null;
    this.bubble.classList.add('is-leaving');
    this.removeTimer = window.setTimeout(() => this.clear(), BUBBLE_FADE_MS);
  }

  private cancelTimers(): void {
    if (this.hideTimer !== null) window.clearTimeout(this.hideTimer);
    if (this.removeTimer !== null) window.clearTimeout(this.removeTimer);
    this.hideTimer = null;
    this.removeTimer = null;
  }
}
