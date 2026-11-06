import './menuKit.css';
import './logPanel.css';
import { formatChips } from '../../shared/format';
import type { Backlog, HandSummary, LogEntry, Narration, NarrationTone } from '../../shared/protocol';
import { clearChildren, createIcon, el, formatClock, safeColor, setData, setHidden, setText, type IconName } from './dom';
import { createMiniCards, warmCardAtlas } from './miniCard';
import { type Selector, createSelector, playerColorOf, playerColorsVersion } from './menuKit';

const MAX_LOG_ENTRIES = 150;
const MAX_HAND_ENTRIES = 40;
/** Open by default only where the ledger covers no seat plate. */
const OPEN_BY_DEFAULT_MIN_WIDTH = 1600;
const MINI_CARD_WIDTH = 30;

type LogTab = 'log' | 'hands';
export type LogFilter = 'all' | 'plays' | 'results';

const TAB_LABELS: Record<LogTab, string> = { log: 'Juiz', hands: 'Mãos' };
const TAB_ORDER: LogTab[] = ['log', 'hands'];

const FILTER_LABELS: Record<LogFilter, string> = { all: 'Tudo', plays: 'Jogadas', results: 'Resultados' };
const FILTER_ORDER: LogFilter[] = ['all', 'plays', 'results'];

const TONE_ICONS: Record<NarrationTone, IconName> = {
  info: 'info',
  action: 'chip',
  street: 'cards',
  win: 'trophy',
  warn: 'warning',
  alert: 'bolt',
};

const PLAY_TONES: readonly NarrationTone[] = ['action', 'alert', 'warn'];

/** Live lines carry the server's clock, like the backlog lines; the device clock is only a fallback. */
export function toLogEntry(narration: Narration, serverTime: number | undefined, fallbackTime: number): LogEntry {
  const time = serverTime !== undefined && Number.isFinite(serverTime) ? serverTime : fallbackTime;
  return { time, text: narration.text, tone: narration.tone };
}

export interface HandStart {
  handNumber: number;
  /** "Dealer Ana, Blinds 10/20": the server's hand-start line without the number. */
  details: string;
}

/** The judge announces each hand as "Mão #12 - Dealer: Ana · Blinds 10/20"; that line becomes a ledger separator. */
export function parseHandStart(text: string): HandStart | null {
  const match = /^Mão #(\d+)\s*(?:[—–-]\s*(.*))?$/.exec(text.trim());
  if (match === null) return null;
  const details = (match[2] ?? '').replace(/\s*·\s*/g, ', ').replace(/:\s*/g, ' ').trim();
  return { handNumber: Number(match[1]), details };
}

export function matchesFilter(tone: NarrationTone, filter: LogFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'plays') return PLAY_TONES.includes(tone);
  return tone === 'win';
}

export interface LedgerGroup {
  /** null for what happened before the first hand (people sitting down, the game starting). */
  handNumber: number | null;
  details: string;
  startedAt: number | null;
  /** Newest first, like the rest of the panel. */
  entries: LogEntry[];
}

/** Groups the chronological log by hand, newest hand first; groups left empty by the filter are dropped. */
export function buildLedger(chronological: readonly LogEntry[], filter: LogFilter): LedgerGroup[] {
  const groups: LedgerGroup[] = [{ handNumber: null, details: '', startedAt: null, entries: [] }];
  for (const entry of chronological) {
    const start = parseHandStart(entry.text);
    if (start !== null) {
      groups.push({ handNumber: start.handNumber, details: start.details, startedAt: entry.time, entries: [] });
      continue;
    }
    if (matchesFilter(entry.tone, filter)) groups[groups.length - 1].entries.unshift(entry);
  }
  return groups.filter((group) => group.entries.length > 0).reverse();
}

function createLedgerRow(entry: LogEntry): HTMLElement {
  return el(
    'li',
    { className: 'ledger__row', dataset: { tone: entry.tone } },
    el('time', { className: 'ledger__time', text: formatClock(entry.time), attrs: { datetime: new Date(entry.time).toISOString() } }),
    el('span', { className: 'ledger__marker', attrs: { 'aria-hidden': 'true' } }, createIcon(TONE_ICONS[entry.tone], 12)),
    el('span', { className: 'ledger__text', text: entry.text }),
  );
}

function createLedgerGroup(group: LedgerGroup): HTMLElement {
  const title = group.handNumber === null ? 'Antes da partida' : `Mão #${group.handNumber}`;
  const rows = el('ol', { className: 'ledger__rows' });
  for (const entry of group.entries) rows.appendChild(createLedgerRow(entry));
  return el(
    'li',
    { className: 'ledger__group', dataset: { hand: group.handNumber === null ? 'none' : String(group.handNumber) } },
    el(
      'header',
      { className: 'ledger__hand' },
      el('h3', { className: 'ledger__hand-title', text: title }),
      group.details === '' ? null : el('span', { className: 'ledger__hand-details', text: group.details }),
    ),
    rows,
  );
}

export class LogPanel {
  readonly element: HTMLElement;
  private readonly toggleButton: HTMLButtonElement;
  private readonly unreadBadge: HTMLElement;
  private readonly body: HTMLElement;
  private readonly tabButtons = new Map<LogTab, HTMLButtonElement>();
  private readonly filterSelector: Selector;
  private readonly ledgerList: HTMLElement;
  private readonly handList: HTMLElement;
  private readonly ledgerEmpty: HTMLElement;
  private readonly handEmpty: HTMLElement;
  private readonly logPane: HTMLElement;
  private readonly handPane: HTMLElement;
  private entries: LogEntry[] = [];
  /** Newest hand first. */
  private hands: HandSummary[] = [];
  private seenColorsVersion = playerColorsVersion();
  private open = false;
  private activeTab: LogTab = 'log';
  private filter: LogFilter = 'all';
  private unread = 0;
  private ledgerDirty = true;
  private handsDirty = true;
  private renderFrame: number | null = null;

  constructor() {
    void warmCardAtlas();
    this.unreadBadge = el('span', { className: 'log-panel__unread', attrs: { hidden: '' } });
    this.toggleButton = el(
      'button',
      { className: 'log-panel__toggle', attrs: { type: 'button', 'aria-controls': 'log-panel-body', 'aria-label': 'Registro do Juiz' } },
      createIcon('log', 18),
      el('span', { className: 'log-panel__toggle-text', text: 'Registro' }),
      this.unreadBadge,
      el('span', { className: 'log-panel__chevron' }, createIcon('chevron', 16)),
    );
    this.toggleButton.addEventListener('click', () => this.setOpen(!this.open));

    this.filterSelector = createSelector({
      name: 'log-filter',
      ariaLabel: 'Filtrar o registro',
      variant: 'segment',
      value: this.filter,
      options: FILTER_ORDER.map((filter) => ({ value: filter, label: FILTER_LABELS[filter] })),
      onChange: (value) => this.setFilter(value as LogFilter),
    });
    this.filterSelector.element.classList.add('log-panel__filters');

    this.ledgerList = el('ol', { className: 'ledger' });
    this.handList = el('ol', { className: 'hand-list' });
    this.ledgerEmpty = el('p', { className: 'log-empty', text: 'As narrações do Juiz aparecem aqui.' });
    this.handEmpty = el('p', { className: 'log-empty', text: 'Nenhuma mão concluída ainda.', attrs: { hidden: '' } });
    this.logPane = el(
      'div',
      { className: 'log-panel__pane', attrs: { role: 'tabpanel', id: 'log-pane-log', 'aria-labelledby': 'log-tab-log' } },
      this.ledgerEmpty,
      this.ledgerList,
    );
    this.handPane = el(
      'div',
      { className: 'log-panel__pane', attrs: { role: 'tabpanel', id: 'log-pane-hands', 'aria-labelledby': 'log-tab-hands', hidden: '' } },
      this.handEmpty,
      this.handList,
    );

    const tabs = el('div', { className: 'log-panel__tabs', attrs: { role: 'tablist', 'aria-label': 'Registro da mesa' } });
    for (const tab of TAB_ORDER) {
      const button = el('button', {
        className: 'log-panel__tab',
        text: TAB_LABELS[tab],
        attrs: { type: 'button', role: 'tab', id: `log-tab-${tab}`, 'aria-controls': `log-pane-${tab}` },
      });
      button.addEventListener('click', () => this.selectTab(tab));
      this.tabButtons.set(tab, button);
      tabs.appendChild(button);
    }
    tabs.addEventListener('keydown', (event) => this.handleTabKey(event));

    this.body = el(
      'div',
      { className: 'log-panel__body', attrs: { id: 'log-panel-body' } },
      el(
        'div',
        { className: 'log-panel__sheet mk-panel mk-panel--compact' },
        el('h2', { className: 'mk-title log-panel__title', text: 'Registro do Juiz' }),
        tabs,
        this.filterSelector.element,
        this.logPane,
        this.handPane,
      ),
    );
    this.element = el('aside', { className: 'log-panel', attrs: { 'aria-label': 'Registro do Juiz' } }, this.toggleButton, this.body);

    this.selectTab('log');
    this.setOpen(typeof window.matchMedia === 'function' && window.matchMedia(`(min-width: ${OPEN_BY_DEFAULT_MIN_WIDTH}px)`).matches);
  }

  /** Newest entries go on top, so the freshest line is always visible without scrolling. */
  announce(narration: Narration, serverTime?: number): void {
    this.entries.push(toLogEntry(narration, serverTime, Date.now()));
    if (this.entries.length > MAX_LOG_ENTRIES) this.entries.splice(0, this.entries.length - MAX_LOG_ENTRIES);
    this.ledgerDirty = true;
    this.scheduleRender();
    if (!this.open) this.setUnread(this.unread + 1);
  }

  setBacklog(backlog: Backlog): void {
    this.entries = backlog.log.slice(-MAX_LOG_ENTRIES);
    this.hands = backlog.hands.slice(-MAX_HAND_ENTRIES).reverse();
    this.ledgerDirty = true;
    this.handsDirty = true;
    this.scheduleRender();
  }

  addHandSummary(summary: HandSummary): void {
    this.hands = [summary, ...this.hands.filter((hand) => hand.handNumber !== summary.handNumber)].slice(0, MAX_HAND_ENTRIES);
    this.handsDirty = true;
    this.scheduleRender();
  }

  private scheduleRender(): void {
    if (!this.open || this.renderFrame !== null) return;
    this.renderFrame = window.requestAnimationFrame(() => {
      this.renderFrame = null;
      this.renderPending();
    });
  }

  private renderPending(): void {
    const colorsVersion = playerColorsVersion();
    if (colorsVersion !== this.seenColorsVersion) {
      this.seenColorsVersion = colorsVersion;
      this.handsDirty = true;
    }
    if (this.ledgerDirty && this.activeTab === 'log') this.renderLedger();
    if (this.handsDirty && this.activeTab === 'hands') this.renderHands();
  }

  private renderLedger(): void {
    this.ledgerDirty = false;
    const groups = buildLedger(this.entries, this.filter);
    this.keepScrollAnchor(this.logPane, () => {
      clearChildren(this.ledgerList);
      for (const group of groups) this.ledgerList.appendChild(createLedgerGroup(group));
    });
    setText(this.ledgerEmpty, this.entries.length === 0 ? 'As narrações do Juiz aparecem aqui.' : 'Nada com este filtro por enquanto.');
    setHidden(this.ledgerEmpty, groups.length > 0);
  }

  private renderHands(): void {
    this.handsDirty = false;
    this.keepScrollAnchor(this.handPane, () => {
      clearChildren(this.handList);
      for (const summary of this.hands) this.handList.appendChild(this.createHandCard(summary));
    });
    setHidden(this.handEmpty, this.hands.length > 0);
  }

  /** New lines arrive on top; a reader scrolled further down keeps seeing the same line. */
  private keepScrollAnchor(pane: HTMLElement, mutate: () => void): void {
    const previousTop = pane.scrollTop;
    const previousHeight = pane.scrollHeight;
    mutate();
    if (previousTop > 0) pane.scrollTop = previousTop + (pane.scrollHeight - previousHeight);
  }

  private createHandCard(summary: HandSummary): HTMLElement {
    const winners = el('ul', { className: 'hand-card__winners' });
    for (const winner of summary.winners) {
      const color = safeColor(playerColorOf(winner.name) ?? '');
      winners.appendChild(
        el(
          'li',
          { className: 'hand-card__winner', style: { '--player-color': color } },
          el('span', { className: 'hand-card__dot', attrs: { 'aria-hidden': 'true' } }),
          el(
            'span',
            { className: 'hand-card__winner-text' },
            el('span', { text: `${winner.name} ganhou ` }),
            el('strong', { className: 'hand-card__amount', text: formatChips(winner.amount) }),
            winner.handName === null ? null : el('span', { className: 'hand-card__hand-name', text: winner.handName }),
          ),
        ),
      );
    }
    const board =
      summary.board.length === 0
        ? el('span', { className: 'hand-card__muted', text: 'Encerrada antes do flop' })
        : createMiniCards(summary.board, { width: MINI_CARD_WIDTH });
    board.classList.add('hand-card__board');
    return el(
      'li',
      { className: 'hand-card', dataset: { hand: String(summary.handNumber) } },
      el(
        'div',
        { className: 'hand-card__head' },
        el('h3', { className: 'hand-card__title', text: `Mão #${summary.handNumber}` }),
        el('span', { className: 'hand-card__pot', text: `Pote ${formatChips(summary.potTotal)}` }),
      ),
      board,
      winners,
    );
  }

  private setOpen(open: boolean): void {
    this.open = open;
    this.body.inert = !open;
    this.toggleButton.setAttribute('aria-expanded', String(open));
    setData(this.element, 'open', open ? 'true' : 'false');
    if (open) {
      this.setUnread(0);
      this.renderPending();
    }
  }

  private setUnread(count: number): void {
    this.unread = count;
    setText(this.unreadBadge, count > 99 ? '99+' : String(count));
    setHidden(this.unreadBadge, count === 0);
  }

  private setFilter(filter: LogFilter): void {
    this.filter = filter;
    this.ledgerDirty = true;
    this.renderPending();
  }

  private selectTab(tab: LogTab): void {
    this.activeTab = tab;
    for (const [name, button] of this.tabButtons) {
      const selected = name === tab;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    setHidden(this.logPane, tab !== 'log');
    setHidden(this.handPane, tab !== 'hands');
    setHidden(this.filterSelector.element, tab !== 'log');
    if (this.open) this.renderPending();
  }

  private handleTabKey(event: KeyboardEvent): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const offset = event.key === 'ArrowRight' ? 1 : -1;
    const next = TAB_ORDER[(TAB_ORDER.indexOf(this.activeTab) + offset + TAB_ORDER.length) % TAB_ORDER.length];
    this.selectTab(next);
    this.tabButtons.get(next)?.focus();
  }
}
