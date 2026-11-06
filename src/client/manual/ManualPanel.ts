import './manual.css';
import { cardLabel } from '../../shared/cards';
import type { HandCategory } from '../../shared/handEvaluator';
import {
  CARD_ATLAS_BACKGROUND_SIZE,
  CARD_ATLAS_URL,
  type ManualBlock,
  type ManualCard,
  type ManualSection,
  type ManualSectionContent,
  GLOSSARY,
  HAND_RANKING,
  MANUAL_SECTIONS,
  cardBackgroundPosition,
  filterGlossary,
  formatProbability,
  handNameToCategory,
  isManualSection,
  parseInlineMarkup,
  probabilityBarRatio,
} from './manualContent';

export type { ManualSection };

type Child = Node | string | null | false;

interface ElementOptions {
  className?: string;
  text?: string;
  attrs?: Record<string, string>;
  dataset?: Record<string, string>;
  style?: Record<string, string>;
}

const CLOSE_TRANSITION_MS = 260;
const FOCUSABLE_SELECTOR = 'button, input, select, textarea, a[href], [tabindex]';
const NON_TEXT_INPUT_TYPES = new Set(['button', 'checkbox', 'color', 'file', 'image', 'radio', 'range', 'reset', 'submit']);
const CALLOUT_LABELS = { tip: 'Dica', example: 'Exemplo', warning: 'Atenção', note: 'Nota' } as const;

let instanceCounter = 0;

/** Builds elements without ever parsing markup, so no copy can inject HTML. */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (options.className) element.className = options.className;
  if (options.text !== undefined) element.textContent = options.text;
  for (const [name, value] of Object.entries(options.attrs ?? {})) element.setAttribute(name, value);
  for (const [name, value] of Object.entries(options.dataset ?? {})) element.dataset[name] = value;
  for (const [name, value] of Object.entries(options.style ?? {})) element.style.setProperty(name, value);
  for (const child of children) {
    if (child === null || child === false) continue;
    element.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return element;
}

function appendInline(parent: Node, source: string): void {
  for (const token of parseInlineMarkup(source)) {
    if (token.kind === 'strong') parent.appendChild(el('strong', { text: token.text }));
    else if (token.kind === 'code') parent.appendChild(el('code', { className: 'manual-code', text: token.text }));
    else parent.appendChild(document.createTextNode(token.text));
  }
}

function richElement<K extends 'p' | 'li' | 'dd' | 'td' | 'figcaption' | 'div'>(
  tag: K,
  className: string,
  source: string,
): HTMLElementTagNameMap[K] {
  const element = el(tag, { className });
  appendInline(element, source);
  return element;
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && !NON_TEXT_INPUT_TYPES.has(target.type);
}

function isToggleShortcut(event: KeyboardEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return false;
  return event.key === '?' || event.key === 'h' || event.key === 'H';
}

function createMiniCard(card: ManualCard, isKicker = false): HTMLSpanElement {
  const baseLabel = card === 'back' ? 'Carta virada' : cardLabel(card);
  return el('span', {
    className: 'mcard',
    attrs: { role: 'img', 'aria-label': isKicker ? `${baseLabel}, kicker` : baseLabel },
    style: { 'background-position': cardBackgroundPosition(card) },
  });
}

/** Trailing `kickerCount` cards are drawn dimmed: they only break ties. */
function createCardGroup(cards: readonly ManualCard[], label: string, kickerCount = 0): HTMLDivElement {
  const group = el('div', { className: 'mcards', attrs: { role: 'group', 'aria-label': label } });
  cards.forEach((card, index) => {
    const isKicker = index >= cards.length - kickerCount;
    const miniCard = createMiniCard(card, isKicker);
    if (isKicker) miniCard.dataset.kicker = 'true';
    group.appendChild(miniCard);
  });
  return group;
}

function createKeyList(keys: readonly string[]): HTMLSpanElement {
  const list = el('span', { className: 'manual-keys' });
  keys.forEach((key, index) => {
    if (index > 0) list.appendChild(el('span', { className: 'manual-keys__or', text: 'ou' }));
    list.appendChild(el('kbd', { className: 'manual-kbd', text: key }));
  });
  return list;
}

export class ManualPanel {
  private readonly uid = ++instanceCounter;
  private readonly overlay: HTMLDivElement;
  private readonly sheet: HTMLElement;
  private readonly tabList: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly shortcutHint: HTMLElement;
  private readonly tabs = new Map<ManualSection, HTMLButtonElement>();
  private readonly panels = new Map<ManualSection, HTMLElement>();
  private readonly rankingRows = new Map<HandCategory, { row: HTMLElement; tag: HTMLElement }>();
  private readonly openButtons = new Set<HTMLButtonElement>();
  private readonly currentHandBanner: HTMLElement;
  private activeSection: ManualSection = 'como-jogar';
  private opened = false;
  private shortcutBound = false;
  private returnFocusTarget: HTMLElement | null = null;
  private hideTimerId: number | null = null;
  private currentCategory: HandCategory | null = null;

  constructor(root: HTMLElement) {
    const titleId = `manual-title-${this.uid}`;

    this.tabList = el('div', {
      className: 'manual__tabs',
      attrs: { role: 'tablist', 'aria-label': 'Seções do manual' },
    });
    this.body = el('div', { className: 'manual__body' });
    this.currentHandBanner = el('p', { className: 'manual-current', attrs: { hidden: '' } });
    this.shortcutHint = el(
      'span',
      { className: 'manual__hint', attrs: { hidden: '' } },
      el('kbd', { className: 'manual-kbd', text: '?' }),
      ' ou ',
      el('kbd', { className: 'manual-kbd', text: 'H' }),
      ' abre e fecha',
    );

    const closeButton = el('button', {
      className: 'manual__close',
      text: '×',
      attrs: { type: 'button', 'aria-label': 'Fechar manual', title: 'Fechar (Esc)' },
    });
    closeButton.addEventListener('click', () => this.close());

    const header = el(
      'header',
      { className: 'manual__header' },
      el('span', { className: 'manual__crest', text: '♠', attrs: { 'aria-hidden': 'true' } }),
      el(
        'div',
        { className: 'manual__heading' },
        el('h2', { className: 'manual__title', text: 'Manual do Jogo', attrs: { id: titleId } }),
        el('p', { className: 'manual__subtitle', text: 'Mesa Real · Texas Hold’em No-Limit' }),
      ),
      closeButton,
    );

    const footer = el(
      'footer',
      { className: 'manual__footer' },
      this.shortcutHint,
      el(
        'span',
        { className: 'manual__hint' },
        el('kbd', { className: 'manual-kbd', text: 'Esc' }),
        ' fecha',
      ),
      el(
        'span',
        { className: 'manual__hint' },
        el('kbd', { className: 'manual-kbd', text: '←' }),
        ' ',
        el('kbd', { className: 'manual-kbd', text: '→' }),
        ' trocam de seção',
      ),
    );

    this.sheet = el(
      'section',
      {
        className: 'manual__sheet',
        attrs: { id: this.dialogId, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' },
      },
      header,
      this.tabList,
      this.body,
      footer,
    );

    const backdrop = el('div', { className: 'manual__backdrop', attrs: { 'aria-hidden': 'true' } });
    backdrop.addEventListener('click', () => this.close());

    this.overlay = el(
      'div',
      {
        className: 'manual',
        dataset: { state: 'closed' },
        attrs: { hidden: '' },
        style: { '--manual-atlas': `url("${CARD_ATLAS_URL}")`, '--manual-atlas-size': CARD_ATLAS_BACKGROUND_SIZE },
      },
      backdrop,
      this.sheet,
    );

    for (const section of MANUAL_SECTIONS) {
      this.tabs.set(section.id, this.createTab(section));
      this.panels.set(section.id, this.createPanel(section));
    }
    for (const tab of this.tabs.values()) this.tabList.appendChild(tab);
    for (const panel of this.panels.values()) this.body.appendChild(panel);

    root.appendChild(this.overlay);
    this.selectSection(this.activeSection);
  }

  get isOpen(): boolean {
    return this.opened;
  }

  open(section?: ManualSection): void {
    this.openFrom(null, section);
  }

  /** `opener` is passed explicitly because Safari and Firefox on macOS do not focus a button on click. */
  private openFrom(opener: HTMLElement | null, section?: ManualSection): void {
    if (section !== undefined && isManualSection(section)) this.selectSection(section);
    if (this.opened) {
      this.focusPanel();
      if (section === 'ranking') this.scrollCurrentHandIntoView();
      return;
    }

    this.opened = true;
    this.cancelPendingHide();
    const active = document.activeElement;
    const focusedElement =
      active instanceof HTMLElement && active !== document.body && !this.overlay.contains(active) ? active : null;
    this.returnFocusTarget = opener ?? focusedElement;

    this.overlay.hidden = false;
    // Reading layout commits the closed state first, so the opacity/transform transition actually runs.
    void this.overlay.offsetWidth;
    this.overlay.dataset.state = 'open';

    // Capture phase on window: the table hotkeys (F = fold) live on window too and must not fire behind the sheet.
    window.addEventListener('keydown', this.handleKeyDown, true);
    document.addEventListener('focusin', this.handleFocusIn);
    this.syncOpenButtons();
    this.focusPanel();

    if (section === 'ranking') this.scrollCurrentHandIntoView();
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    document.removeEventListener('focusin', this.handleFocusIn);
    if (!this.shortcutBound) window.removeEventListener('keydown', this.handleKeyDown, true);

    this.overlay.dataset.state = 'closed';
    this.syncOpenButtons();

    const target = this.returnFocusTarget;
    this.returnFocusTarget = null;
    if (target !== null && target.isConnected) target.focus({ preventScroll: true });

    this.cancelPendingHide();
    if (prefersReducedMotion()) {
      this.overlay.hidden = true;
      return;
    }
    this.hideTimerId = window.setTimeout(() => {
      this.hideTimerId = null;
      if (!this.opened) this.overlay.hidden = true;
    }, CLOSE_TRANSITION_MS);
  }

  toggle(): void {
    if (this.opened) this.close();
    else this.open();
  }

  createOpenButton(options: { label?: string; compact?: boolean } = {}): HTMLButtonElement {
    const compact = options.compact === true;
    const accessibleName = options.label ?? 'Manual do Jogo';
    const button = el('button', {
      className: compact ? 'manual-open-btn manual-open-btn--compact' : 'manual-open-btn',
      attrs: {
        type: 'button',
        'aria-haspopup': 'dialog',
        'aria-expanded': 'false',
        'aria-controls': this.dialogId,
        title: this.openButtonTitle,
      },
    });
    if (compact) {
      button.setAttribute('aria-label', accessibleName);
      button.appendChild(el('span', { className: 'manual-open-btn__icon', text: '📖', attrs: { 'aria-hidden': 'true' } }));
    } else if (options.label !== undefined) {
      button.appendChild(el('span', { className: 'manual-open-btn__label', text: options.label }));
    } else {
      button.append(
        el('span', { className: 'manual-open-btn__icon', text: '📖', attrs: { 'aria-hidden': 'true' } }),
        el('span', { className: 'manual-open-btn__label', text: 'Manual' }),
      );
    }
    button.addEventListener('click', () => {
      if (this.opened) this.close();
      else this.openFrom(button);
    });
    button.setAttribute('aria-expanded', String(this.opened));
    this.openButtons.add(button);
    return button;
  }

  /** Marks the ranking row of the category the viewer holds right now; null or an unknown name clears it. */
  highlightHand(handName: string | null): void {
    const category = handNameToCategory(handName);
    this.currentCategory = category;

    for (const [rowCategory, { row, tag }] of this.rankingRows) {
      const isCurrent = rowCategory === category;
      row.dataset.current = String(isCurrent);
      if (isCurrent) row.setAttribute('aria-current', 'true');
      else row.removeAttribute('aria-current');
      tag.hidden = !isCurrent;
    }

    this.currentHandBanner.hidden = category === null;
    if (category !== null && handName !== null) {
      this.currentHandBanner.replaceChildren(
        el('span', { className: 'manual-current__label', text: 'Você tem agora' }),
        el('strong', { className: 'manual-current__name', text: handName }),
      );
    }
  }

  bindShortcut(): void {
    this.shortcutBound = true;
    this.shortcutHint.hidden = false;
    for (const button of this.openButtons) button.title = this.openButtonTitle;
    window.addEventListener('keydown', this.handleKeyDown, true);
  }

  dispose(): void {
    this.cancelPendingHide();
    window.removeEventListener('keydown', this.handleKeyDown, true);
    document.removeEventListener('focusin', this.handleFocusIn);
    this.opened = false;
    this.shortcutBound = false;
    this.overlay.remove();
    this.openButtons.clear();
  }

  private get dialogId(): string {
    return `manual-dialog-${this.uid}`;
  }

  private get openButtonTitle(): string {
    return this.shortcutBound ? 'Manual do Jogo (?)' : 'Manual do Jogo';
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (event.isComposing) return;

    if (!this.opened) {
      if (this.shortcutBound && isToggleShortcut(event) && !isTypingTarget(event.target)) {
        event.preventDefault();
        this.open();
      }
      return;
    }

    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
    } else if (event.key === 'Tab') {
      this.trapTab(event);
    } else if (this.shortcutBound && isToggleShortcut(event) && !isTypingTarget(event.target)) {
      event.preventDefault();
      this.close();
    } else if (event.target instanceof HTMLElement && this.tabList.contains(event.target)) {
      this.handleTabNavigation(event);
    }
  };

  private readonly handleFocusIn = (event: FocusEvent): void => {
    if (this.opened && event.target instanceof Node && !this.overlay.contains(event.target)) this.focusPanel();
  };

  private trapTab(event: KeyboardEvent): void {
    const focusable = this.getFocusableElements();
    if (focusable.length === 0) {
      event.preventDefault();
      this.sheet.focus({ preventScroll: true });
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    const insideSheet = active instanceof Node && this.sheet.contains(active);

    if (event.shiftKey && (!insideSheet || active === first || active === this.sheet)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (!insideSheet || active === last)) {
      event.preventDefault();
      first.focus();
    }
  }

  private getFocusableElements(): HTMLElement[] {
    return Array.from(this.sheet.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
      (element) =>
        element.tabIndex >= 0 &&
        !(element instanceof HTMLButtonElement && element.disabled) &&
        !(element instanceof HTMLInputElement && element.disabled) &&
        element.getClientRects().length > 0,
    );
  }

  private handleTabNavigation(event: KeyboardEvent): void {
    const sections = MANUAL_SECTIONS.map((section) => section.id);
    const currentIndex = sections.indexOf(this.activeSection);
    let nextIndex = currentIndex;

    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        nextIndex = (currentIndex + 1) % sections.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        nextIndex = (currentIndex - 1 + sections.length) % sections.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = sections.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    this.selectSection(sections[nextIndex], true);
  }

  private focusPanel(): void {
    const target = this.panels.get(this.activeSection) ?? this.sheet;
    target.focus({ preventScroll: true });
  }

  private selectSection(section: ManualSection, focusTab = false): void {
    this.activeSection = section;
    for (const [id, tab] of this.tabs) {
      const selected = id === section;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      const panel = this.panels.get(id);
      if (panel) panel.hidden = !selected;
    }
    this.body.scrollTop = 0;

    const selectedTab = this.tabs.get(section);
    if (selectedTab === undefined) return;
    if (focusTab) selectedTab.focus({ preventScroll: true });
    // Keeps the selected tab visible when the tab bar scrolls sideways on narrow screens.
    selectedTab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  private scrollCurrentHandIntoView(): void {
    if (this.currentCategory === null) return;
    const entry = this.rankingRows.get(this.currentCategory);
    entry?.row.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }

  private syncOpenButtons(): void {
    for (const button of this.openButtons) button.setAttribute('aria-expanded', String(this.opened));
  }

  private cancelPendingHide(): void {
    if (this.hideTimerId === null) return;
    window.clearTimeout(this.hideTimerId);
    this.hideTimerId = null;
  }

  /* ----------------------------------------------------------------------------------------- */
  /* Rendering                                                                                  */
  /* ----------------------------------------------------------------------------------------- */

  private createTab(section: ManualSectionContent): HTMLButtonElement {
    const tab = el(
      'button',
      {
        className: 'manual__tab',
        attrs: {
          type: 'button',
          role: 'tab',
          id: this.tabId(section.id),
          'aria-controls': this.panelId(section.id),
          'aria-selected': 'false',
        },
        dataset: { section: section.id },
      },
      el('span', { className: 'manual__tab-glyph', text: section.glyph, attrs: { 'aria-hidden': 'true' } }),
      el('span', { className: 'manual__tab-label', text: section.title }),
    );
    tab.tabIndex = -1;
    tab.addEventListener('click', () => this.selectSection(section.id));
    return tab;
  }

  private tabId(section: ManualSection): string {
    return `manual-${this.uid}-tab-${section}`;
  }

  private panelId(section: ManualSection): string {
    return `manual-${this.uid}-panel-${section}`;
  }

  private createPanel(section: ManualSectionContent): HTMLElement {
    const panel = el('div', {
      className: 'manual__panel',
      attrs: {
        role: 'tabpanel',
        id: this.panelId(section.id),
        'aria-labelledby': this.tabId(section.id),
        tabindex: '0',
        hidden: '',
      },
    });

    panel.appendChild(
      el(
        'div',
        { className: 'manual-intro' },
        el('h3', { className: 'manual-intro__title', text: section.title }),
        el('p', { className: 'manual-intro__summary', text: section.summary }),
      ),
    );

    const headings: { text: string; element: HTMLElement }[] = [];
    const content = el('div', { className: 'manual-content' });
    section.blocks.forEach((block, index) => {
      const element = this.renderBlock(block, `${section.id}-${index}`);
      if (block.kind === 'heading') headings.push({ text: block.text, element });
      content.appendChild(element);
    });

    if (headings.length >= 4) panel.appendChild(this.createTableOfContents(headings));
    panel.appendChild(content);
    return panel;
  }

  private createTableOfContents(headings: readonly { text: string; element: HTMLElement }[]): HTMLElement {
    const nav = el('nav', { className: 'manual-toc', attrs: { 'aria-label': 'Nesta seção' } });
    for (const heading of headings) {
      const link = el('button', { className: 'manual-toc__link', text: heading.text, attrs: { type: 'button' } });
      link.addEventListener('click', () => {
        heading.element.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
        heading.element.focus({ preventScroll: true });
      });
      nav.appendChild(link);
    }
    return nav;
  }

  private renderBlock(block: ManualBlock, key: string): HTMLElement {
    switch (block.kind) {
      case 'heading':
        return el('h4', { className: 'manual-h4', text: block.text, attrs: { tabindex: '-1', id: `manual-${this.uid}-${key}` } });
      case 'paragraph':
        return richElement('p', 'manual-p', block.text);
      case 'list': {
        const list = el(block.ordered ? 'ol' : 'ul', { className: 'manual-list' });
        for (const item of block.items) list.appendChild(richElement('li', 'manual-list__item', item));
        return list;
      }
      case 'steps':
        return this.renderSteps(block.items);
      case 'definitions':
        return this.renderDefinitions(block.items);
      case 'callout':
        return this.renderCallout(block);
      case 'table':
        return this.renderTable(block);
      case 'cards': {
        const figure = el('figure', { className: 'manual-figure' });
        figure.append(createCardGroup(block.cards, 'Cartas de exemplo'), richElement('figcaption', 'manual-figure__caption', block.caption));
        return figure;
      }
      case 'shortcuts':
        return this.renderShortcuts(block.items);
      case 'features':
        return this.renderFeatures(block.items);
      case 'ranking':
        return this.renderRanking();
      case 'glossary':
        return this.renderGlossary();
    }
  }

  private renderSteps(items: readonly { title: string; text: string; cards?: readonly ManualCard[] }[]): HTMLElement {
    const list = el('ol', { className: 'manual-flow' });
    items.forEach((step, index) => {
      const body = el(
        'div',
        { className: 'manual-flow__body' },
        el('div', { className: 'manual-flow__title', text: step.title }),
        richElement('p', 'manual-flow__text', step.text),
      );
      const item = el(
        'li',
        { className: 'manual-flow__item' },
        el('span', { className: 'manual-flow__marker', text: String(index + 1), attrs: { 'aria-hidden': 'true' } }),
        body,
      );
      if (step.cards !== undefined) {
        const cardsLabel = step.cards.every((card) => card === 'back') ? `${step.title}: cartas viradas` : `${step.title}: cartas de exemplo`;
        item.appendChild(el('div', { className: 'manual-flow__cards' }, createCardGroup(step.cards, cardsLabel)));
      }
      list.appendChild(item);
    });
    return list;
  }

  private renderDefinitions(
    items: readonly { term: string; text: string; keys?: readonly string[]; tone?: string }[],
  ): HTMLElement {
    const list = el('dl', { className: 'manual-defs' });
    for (const definition of items) {
      const term = el('dt', { className: 'manual-defs__term' }, el('span', { text: definition.term }));
      if (definition.keys !== undefined) term.appendChild(createKeyList(definition.keys));
      list.appendChild(
        el(
          'div',
          { className: 'manual-defs__item', dataset: { tone: definition.tone ?? 'neutral' } },
          term,
          richElement('dd', 'manual-defs__text', definition.text),
        ),
      );
    }
    return list;
  }

  private renderCallout(block: Extract<ManualBlock, { kind: 'callout' }>): HTMLElement {
    const callout = el(
      'aside',
      { className: 'manual-callout', dataset: { tone: block.tone }, attrs: { role: 'note' } },
      el('div', { className: 'manual-callout__title', text: block.title || CALLOUT_LABELS[block.tone] }),
    );
    if (block.text !== undefined) callout.appendChild(richElement('p', 'manual-callout__text', block.text));
    if (block.items !== undefined) {
      const list = el('ul', { className: 'manual-callout__list' });
      for (const item of block.items) list.appendChild(richElement('li', 'manual-callout__item', item));
      callout.appendChild(list);
    }
    return callout;
  }

  private renderTable(block: Extract<ManualBlock, { kind: 'table' }>): HTMLElement {
    const head = el('tr', {}, ...block.headers.map((header) => el('th', { text: header, attrs: { scope: 'col' } })));
    const rows = block.rows.map((cells) => el('tr', {}, ...cells.map((cell) => richElement('td', 'manual-table__cell', cell))));
    const table = el(
      'table',
      { className: 'manual-table' },
      el('caption', { className: 'manual-table__caption', text: block.caption }),
      el('thead', {}, head),
      el('tbody', {}, ...rows),
    );
    return el('div', { className: 'manual-table-wrap' }, table);
  }

  private renderShortcuts(items: readonly { keys: readonly string[]; text: string }[]): HTMLElement {
    const list = el('ul', { className: 'manual-shortcuts' });
    for (const shortcut of items) {
      list.appendChild(
        el(
          'li',
          { className: 'manual-shortcuts__item' },
          createKeyList(shortcut.keys),
          el('span', { className: 'manual-shortcuts__text', text: shortcut.text }),
        ),
      );
    }
    return list;
  }

  private renderFeatures(items: readonly { glyph: string; title: string; text: string }[]): HTMLElement {
    const grid = el('ul', { className: 'manual-features' });
    for (const feature of items) {
      grid.appendChild(
        el(
          'li',
          { className: 'manual-feature' },
          el('span', { className: 'manual-feature__glyph', text: feature.glyph, attrs: { 'aria-hidden': 'true' } }),
          el('div', { className: 'manual-feature__title', text: feature.title }),
          richElement('p', 'manual-feature__text', feature.text),
        ),
      );
    }
    return grid;
  }

  private renderRanking(): HTMLElement {
    const wrapper = el('div', { className: 'manual-ranking-wrap' });
    wrapper.appendChild(this.currentHandBanner);
    wrapper.appendChild(
      el(
        'div',
        { className: 'manual-ranking__scale', attrs: { 'aria-hidden': 'true' } },
        el('span', { text: '▲ mais forte' }),
        el('span', { text: 'mais fraca ▼' }),
      ),
    );

    const list = el('ol', { className: 'manual-ranking' });
    for (const entry of HAND_RANKING) {
      const tag = el('span', { className: 'manual-rank__tag', text: 'Você tem agora', attrs: { hidden: '' } });
      const ratio = probabilityBarRatio(entry.probabilityPercent);
      const row = el(
        'li',
        { className: 'manual-rank', dataset: { current: 'false', category: String(entry.category) } },
        el('span', { className: 'manual-rank__number', text: String(entry.position), attrs: { 'aria-hidden': 'true' } }),
        el(
          'div',
          { className: 'manual-rank__head' },
          el('h4', { className: 'manual-rank__name', text: entry.name }),
          tag,
        ),
        createCardGroup(entry.cards, `Exemplo de ${entry.name}`, entry.kickerCount),
        el(
          'div',
          { className: 'manual-rank__info' },
          el('p', { className: 'manual-rank__desc', text: entry.description }),
          el(
            'p',
            { className: 'manual-rank__tiebreak' },
            el('span', { className: 'manual-rank__tiebreak-label', text: 'Desempate: ' }),
            entry.tiebreak,
          ),
        ),
        el(
          'div',
          { className: 'manual-rank__odds' },
          el(
            'div',
            { className: 'manual-rank__bar', attrs: { 'aria-hidden': 'true' } },
            el('span', { className: 'manual-rank__fill', style: { width: `${(ratio * 100).toFixed(1)}%` } }),
          ),
          el(
            'span',
            { className: 'manual-rank__pct' },
            el('span', { className: 'manual-rank__pct-label', text: 'Chance com 7 cartas ' }),
            el('strong', { text: formatProbability(entry.probabilityPercent) }),
          ),
        ),
      );
      this.rankingRows.set(entry.category, { row, tag });
      list.appendChild(row);
    }
    wrapper.appendChild(list);
    wrapper.appendChild(
      el('p', {
        className: 'manual-ranking__footnote',
        text: 'A barra de chance usa escala logarítmica, para que as mãos raras continuem visíveis ao lado das comuns.',
      }),
    );
    return wrapper;
  }

  private renderGlossary(): HTMLElement {
    const searchId = `manual-${this.uid}-glossary-search`;
    const input = el('input', {
      className: 'manual-search__input',
      attrs: { id: searchId, type: 'search', placeholder: 'Buscar termo…', autocomplete: 'off', spellcheck: 'false' },
    });
    const status = el('p', { className: 'manual-search__status', attrs: { role: 'status' } });
    const empty = el('p', { className: 'manual-glossary__empty', text: 'Nenhum termo encontrado.', attrs: { hidden: '' } });

    const list = el('dl', { className: 'manual-glossary' });
    const items = GLOSSARY.map((entry) => {
      const item = el(
        'div',
        { className: 'manual-glossary__item' },
        el(
          'dt',
          { className: 'manual-glossary__term' },
          entry.term,
          entry.aliases !== undefined && entry.aliases.length > 0
            ? el('span', { className: 'manual-glossary__aliases', text: entry.aliases.join(' · ') })
            : null,
        ),
        el('dd', { className: 'manual-glossary__definition', text: entry.definition }),
      );
      list.appendChild(item);
      return { entry, item };
    });

    const applyFilter = (): void => {
      const matches = new Set(filterGlossary(GLOSSARY, input.value));
      for (const { entry, item } of items) item.hidden = !matches.has(entry);
      empty.hidden = matches.size > 0;
      status.textContent = matches.size === GLOSSARY.length ? `${GLOSSARY.length} termos` : `${matches.size} de ${GLOSSARY.length} termos`;
    };
    input.addEventListener('input', applyFilter);
    applyFilter();

    return el(
      'div',
      { className: 'manual-glossary-wrap' },
      el(
        'div',
        { className: 'manual-search' },
        el('label', { className: 'manual-search__label', text: 'Buscar no glossário', attrs: { for: searchId } }),
        input,
        status,
      ),
      list,
      empty,
    );
  }
}
