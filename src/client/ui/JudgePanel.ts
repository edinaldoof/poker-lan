import './judgePanel.css';
import { formatChips } from '../../shared/format';
import type { Narration, Street, TableView } from '../../shared/protocol';
import { computeTotalPot, createIcon, el, restartAnimation, setData, setHidden, setText } from './dom';
import { createToneIcon } from './hudIcons';

type PlayedStreet = Exclude<Street, 'idle'>;
export type StepState = 'done' | 'current' | 'todo';

export interface StreetStep {
  street: PlayedStreet;
  label: string;
  state: StepState;
}

const STREET_STEPS: { street: PlayedStreet; label: string }[] = [
  { street: 'preflop', label: 'Pré-flop' },
  { street: 'flop', label: 'Flop' },
  { street: 'turn', label: 'Turn' },
  { street: 'river', label: 'River' },
  { street: 'showdown', label: 'Showdown' },
];

const WELCOME_HEADLINE = 'O Juiz está pronto. Boa sorte na mesa!';
const TONE_ICON_SIZE = 16;

/** Between hands ('idle') nothing is in progress, so every step is still ahead. */
export function streetSteps(street: Street): StreetStep[] {
  const currentIndex = STREET_STEPS.findIndex((step) => step.street === street);
  return STREET_STEPS.map((step, index) => {
    let state: StepState = 'todo';
    if (currentIndex >= 0) state = index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'todo';
    return { ...step, state };
  });
}

/** Compact ledger at the top-left: hand, blinds, pot, the street's progress and the Judge's latest line. */
export class JudgePanel {
  readonly element: HTMLElement;
  private readonly hand: HTMLElement;
  private readonly blinds: HTMLElement;
  private readonly blindsValue: HTMLElement;
  private readonly pot: HTMLElement;
  private readonly potValue: HTMLElement;
  private readonly streets: HTMLElement;
  private readonly stepItems = new Map<PlayedStreet, HTMLElement>();
  private readonly headline: HTMLElement;
  private readonly headlineIcon: HTMLElement;
  private readonly headlineText: HTMLElement;
  private lastPot = -1;

  constructor() {
    this.hand = el('span', { className: 'judge__hand', attrs: { hidden: '' } });
    this.blindsValue = el('strong');
    this.blinds = el(
      'span',
      { className: 'judge__blinds', attrs: { title: 'Blinds (small e big)' } },
      el('span', { className: 'judge__blinds-label', text: 'Blinds' }),
      this.blindsValue,
    );
    this.potValue = el('strong', { className: 'judge__pot-value', text: '0' });
    this.pot = el('span', { className: 'judge__pot', attrs: { hidden: '' } }, el('span', { className: 'judge__pot-label', text: 'Pote' }), this.potValue);

    this.streets = el('ol', { className: 'judge__streets', attrs: { 'aria-label': 'Rodada da mão' } });
    for (const step of STREET_STEPS) {
      const item = el(
        'li',
        { className: 'judge__step', dataset: { state: 'todo' } },
        el('span', { className: 'judge__step-dot', attrs: { 'aria-hidden': 'true' } }),
        el('span', { className: 'judge__step-label', text: step.label }),
      );
      this.stepItems.set(step.street, item);
      this.streets.appendChild(item);
    }

    this.headlineIcon = el('span', { className: 'judge__headline-icon' }, createToneIcon('info', TONE_ICON_SIZE));
    this.headlineText = el('span', { className: 'judge__headline-text', text: WELCOME_HEADLINE });
    this.headline = el('p', { className: 'judge__headline', attrs: { 'aria-live': 'polite' }, dataset: { tone: 'info' } }, this.headlineIcon, this.headlineText);

    this.element = el(
      'section',
      { className: 'judge', attrs: { 'aria-label': 'Juiz da mesa' } },
      el(
        'div',
        { className: 'judge__top' },
        el('span', { className: 'judge__title' }, createIcon('scale', 16), el('span', { className: 'judge__title-text', text: 'Juiz' })),
        this.hand,
        this.blinds,
        this.pot,
      ),
      this.streets,
      this.headline,
    );
  }

  update(state: TableView): void {
    const inLobby = state.phase === 'lobby';
    const handLabel = inLobby ? 'Sala de espera' : state.handNumber > 0 ? `Mão #${state.handNumber}` : null;

    setHidden(this.hand, handLabel === null);
    if (handLabel !== null) setText(this.hand, handLabel);
    setHidden(this.streets, inLobby);
    setText(this.blindsValue, `${formatChips(state.config.smallBlind)}/${formatChips(state.config.bigBlind)}`);
    setHidden(this.pot, inLobby);
    this.paintSteps(state.street);
    this.paintPot(computeTotalPot(state));
  }

  announce(narration: Narration): void {
    setText(this.headlineText, narration.text);
    setData(this.headline, 'tone', narration.tone);
    this.headlineIcon.replaceChildren(createToneIcon(narration.tone, TONE_ICON_SIZE));
    restartAnimation(this.headline, 'is-entering');
  }

  private paintSteps(street: Street): void {
    for (const step of streetSteps(street)) {
      const item = this.stepItems.get(step.street);
      if (item === undefined) continue;
      setData(item, 'state', step.state);
      if (step.state === 'current') item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    }
  }

  private paintPot(pot: number): void {
    if (pot === this.lastPot) return;
    if (this.lastPot >= 0 && pot > this.lastPot) restartAnimation(this.pot, 'is-bumped');
    this.lastPot = pot;
    setText(this.potValue, formatChips(pot));
  }
}
