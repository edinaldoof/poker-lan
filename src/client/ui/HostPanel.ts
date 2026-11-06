import './menuKit.css';
import './hostPanel.css';
import { formatChips } from '../../shared/format';
import { MAX_SEATS, type SeatView, type TableConfig, type TableView } from '../../shared/protocol';
import { clearChildren, el, safeColor, setDisabled, setHidden, setText } from './dom';
import { type Disclosure, type Selector, createButton, createDisclosure, createSelector, rememberPlayerColors } from './menuKit';

export interface HostCallbacks {
  onAddBot(): void;
  onRemoveBot(): void;
  onStart(config: Partial<TableConfig>): void;
}

const MIN_PLAYERS_TO_START = 2;

export const BLIND_OPTIONS = [
  { smallBlind: 5, bigBlind: 10 },
  { smallBlind: 10, bigBlind: 20 },
  { smallBlind: 25, bigBlind: 50 },
  { smallBlind: 50, bigBlind: 100 },
];
export const STACK_OPTIONS = [1000, 2000, 5000, 10000];
export const TURN_SECONDS_OPTIONS = [15, 30, 45, 60];

/** Same floor the server enforces when the game starts (GameController.resolveStartConfig). */
const MIN_STACK_IN_BIG_BLINDS = 20;

/** Starting stacks the server accepts for the given big blind. */
export function selectableStacks(bigBlind: number): number[] {
  return STACK_OPTIONS.filter((stack) => stack >= MIN_STACK_IN_BIG_BLINDS * bigBlind);
}

/** Keeps a valid stack when the blinds change; otherwise falls to the smallest stack the server accepts. */
export function adjustStackForBlinds(stack: number, bigBlind: number): number {
  const allowed = selectableStacks(bigBlind);
  if (allowed.length === 0 || allowed.includes(stack)) return stack;
  return allowed[0];
}

export function stackInBigBlinds(stack: number, bigBlind: number): number {
  return bigBlind > 0 ? Math.floor(stack / bigBlind) : 0;
}

/** Why some stacks are unavailable at these blinds; null when every stack is allowed. */
export function describeStackRule(smallBlind: number, bigBlind: number): string | null {
  if (selectableStacks(bigBlind).length === STACK_OPTIONS.length) return null;
  const minimum = MIN_STACK_IN_BIG_BLINDS * bigBlind;
  return `Com blinds ${smallBlind}/${bigBlind} a mesa pede ao menos ${formatChips(minimum)} fichas, ou seja, ${MIN_STACK_IN_BIG_BLINDS} big blinds.`;
}

/** 1.000 becomes "1K", 10.000 becomes "10K"; smaller amounts stay as they are. */
export function formatCompactChips(amount: number): string {
  return amount >= 1000 && amount % 1000 === 0 ? `${amount / 1000}K` : String(amount);
}

export function missingPlayersMessage(seated: number): string {
  if (seated >= MIN_PLAYERS_TO_START) return 'Qualquer jogador sentado pode iniciar a partida.';
  const missing = MIN_PLAYERS_TO_START - seated;
  return `Falta ${missing} ${missing === 1 ? 'jogador' : 'jogadores'}. Adicione um bot ou chame alguém.`;
}

/* ---------- Roster ---------- */

export type RosterTag = 'Você' | 'Bot';

export function rosterTag(isBot: boolean, isViewer: boolean): RosterTag | null {
  if (isViewer) return 'Você';
  return isBot ? 'Bot' : null;
}

/** The server names bots "Bia (Bot)"; the roster label adds its own "(bot)" marker, so the suffix is dropped first. */
export function rosterDisplayName(name: string, isBot: boolean): string {
  if (!isBot) return name;
  const withoutSuffix = name.replace(/\s*\(bot\)/i, '').trim();
  return withoutSuffix === '' ? name : withoutSuffix;
}

/** The viewer comes first, so "you" is always the line that is easiest to find; the rest keep seat order. */
export function rosterOrder<T extends { seat: number }>(seated: readonly T[], viewerSeat: number | null): T[] {
  return [...seated].sort((first, second) => Number(second.seat === viewerSeat) - Number(first.seat === viewerSeat) || first.seat - second.seat);
}

function rosterLabel(seat: SeatView, isViewer: boolean): string {
  const tag = rosterTag(seat.isBot, isViewer);
  const name = rosterDisplayName(seat.name, seat.isBot);
  return tag === null ? name : `${name} (${tag === 'Bot' ? 'bot' : 'você'})`;
}

/** Each seated player is an avatar in their colour; the names are on the table plates, so the card keeps a name for tooltip and screen readers only. */
function createRosterItem(seat: SeatView, isViewer: boolean): HTMLElement {
  const label = rosterLabel(seat, isViewer);
  return el(
    'li',
    { className: 'roster__item', dataset: { seat: String(seat.seat), you: String(isViewer), bot: String(seat.isBot) }, attrs: { title: label } },
    el('span', { className: 'roster__avatar', text: seat.avatar, style: { '--player-color': safeColor(seat.color) }, attrs: { 'aria-hidden': 'true' } }),
    el('span', { className: 'visually-hidden', text: label }),
  );
}

function createEmptyRosterItem(): HTMLElement {
  return el('li', { className: 'roster__item', dataset: { empty: 'true' }, attrs: { 'aria-hidden': 'true' } }, el('span', { className: 'roster__avatar' }));
}

function rosterKey(seats: readonly (SeatView | null)[], viewerSeat: number | null): string {
  return seats.map((seat) => (seat === null ? '-' : `${seat.seat}:${seat.name}:${seat.color}:${seat.avatar}:${seat.isBot}`)).join('|') + `@${viewerSeat}`;
}

function createFieldRow(label: string, selector: Selector): HTMLElement {
  return el('div', { className: 'host-field' }, el('span', { className: 'mk-label', text: label }), selector.element);
}

/** What the collapsed "Ajustes da mesa" row says: the three choices in one short line. */
export function describeTableSettings(smallBlind: number, bigBlind: number, startingStack: number, turnSeconds: number): string {
  return `${smallBlind}/${bigBlind}, ${formatCompactChips(startingStack)}, ${turnSeconds} s`;
}

/** Waiting-room card plus the compact bot pill shown while a game is running. */
export class HostPanel {
  readonly lobbyElement: HTMLElement;
  readonly compactElement: HTMLElement;
  private readonly blindsSelector: Selector;
  private readonly stackSelector: Selector;
  private readonly turnSelector: Selector;
  private readonly settings: Disclosure;
  private readonly settingsSummary: HTMLElement;
  private readonly roster: HTMLElement;
  private readonly playerCount: HTMLElement;
  private readonly ruleNote: HTMLElement;
  private readonly startHint: HTMLElement;
  private readonly startButton: HTMLButtonElement;
  private readonly addBotButton: HTMLButtonElement;
  private readonly removeBotButton: HTMLButtonElement;
  private readonly compactAddButton: HTMLButtonElement;
  private readonly compactRemoveButton: HTMLButtonElement;
  private fieldsInitialized = false;
  private renderedRosterKey = '';

  constructor(private readonly callbacks: HostCallbacks) {
    this.blindsSelector = createSelector({
      name: 'host-blinds',
      ariaLabel: 'Blinds',
      variant: 'segment',
      value: `${BLIND_OPTIONS[1].smallBlind}/${BLIND_OPTIONS[1].bigBlind}`,
      options: BLIND_OPTIONS.map(({ smallBlind, bigBlind }) => ({
        value: `${smallBlind}/${bigBlind}`,
        label: `Blinds ${smallBlind} e ${bigBlind}`,
        face: `${smallBlind}/${bigBlind}`,
      })),
      onChange: () => this.handleBlindsChange(),
    });
    this.stackSelector = createSelector({
      name: 'host-stack',
      ariaLabel: 'Fichas iniciais',
      variant: 'segment',
      value: String(STACK_OPTIONS[1]),
      options: STACK_OPTIONS.map((stack) => ({ value: String(stack), label: `${formatChips(stack)} fichas`, face: formatCompactChips(stack) })),
      onChange: () => this.refreshStackOptions(),
    });
    this.turnSelector = createSelector({
      name: 'host-turn',
      ariaLabel: 'Tempo por jogada',
      variant: 'segment',
      value: '30',
      options: TURN_SECONDS_OPTIONS.map((seconds) => ({ value: String(seconds), label: `${seconds} segundos`, face: `${seconds} s` })),
      onChange: () => this.refreshSettingsSummary(),
    });

    this.roster = el('ul', { className: 'roster', attrs: { 'aria-label': 'Jogadores sentados' } });
    this.playerCount = el('span', { className: 'host-card__count' });
    this.ruleNote = el('p', { className: 'mk-hint host-card__rule', attrs: { role: 'status' } });
    this.startHint = el('p', { className: 'mk-hint host-card__hint', attrs: { id: 'host-start-hint' } });
    this.startButton = createButton({ label: 'Iniciar partida', tone: 'cta', qa: 'start' });
    this.startButton.setAttribute('aria-describedby', 'host-start-hint');
    this.addBotButton = createButton({ label: 'Bot', icon: 'plus', qa: 'add-bot', title: 'Adicionar um bot à mesa', ariaLabel: 'Adicionar bot' });
    this.removeBotButton = createButton({ label: 'Bot', icon: 'minus', qa: 'remove-bot', title: 'Remover o último bot', ariaLabel: 'Remover bot' });
    this.compactAddButton = createButton({ label: 'Bot', icon: 'plus', small: true, qa: 'add-bot', title: 'Adicionar um bot à mesa', ariaLabel: 'Adicionar bot' });
    this.compactRemoveButton = createButton({ label: 'Bot', icon: 'minus', small: true, qa: 'remove-bot', title: 'Remover o último bot', ariaLabel: 'Remover bot' });

    this.settings = createDisclosure({
      label: 'Ajustes da mesa',
      content: el(
        'div',
        { className: 'host-card__config' },
        createFieldRow('Blinds', this.blindsSelector),
        createFieldRow('Fichas', this.stackSelector),
        createFieldRow('Tempo', this.turnSelector),
        this.ruleNote,
      ),
    });
    // The collapsed row still tells the host what the table will use, so opening it is only needed to change something.
    this.settingsSummary = el('span', { className: 'host-card__summary' });
    this.settings.element.querySelector('.mk-disclosure__label')?.appendChild(this.settingsSummary);

    this.lobbyElement = el(
      'section',
      { className: 'host-card mk-panel mk-panel--compact', attrs: { 'aria-label': 'Sala de espera', hidden: '' } },
      el('header', { className: 'host-card__head' }, el('h2', { className: 'mk-title', text: 'Sala de espera' }), this.playerCount),
      this.roster,
      this.settings.element,
      el('div', { className: 'host-card__actions' }, this.addBotButton, this.removeBotButton, this.startButton),
      this.startHint,
    );
    this.compactElement = el(
      'div',
      { className: 'host-compact', attrs: { role: 'group', 'aria-label': 'Bots', hidden: '' } },
      this.compactAddButton,
      this.compactRemoveButton,
    );

    this.refreshStackOptions();
    this.bindEvents();
  }

  update(state: TableView): void {
    rememberPlayerColors(state.seats);
    const isLobby = state.phase === 'lobby';
    const canControl = !state.self.isSpectator && state.self.seat !== null;
    setHidden(this.lobbyElement, !(isLobby && canControl));
    setHidden(this.compactElement, !(!isLobby && canControl));
    if (!canControl) return;

    if (!this.fieldsInitialized) this.initializeFields(state);

    const seated = state.seats.filter((seat): seat is SeatView => seat !== null);
    const hasBot = seated.some((seat) => seat.isBot);
    const isFull = seated.length >= MAX_SEATS;
    const canStart = seated.length >= MIN_PLAYERS_TO_START;

    this.renderRoster(state, seated);
    setText(this.playerCount, `${seated.length} de ${MAX_SEATS} lugares`);
    setDisabled(this.startButton, !canStart);
    setText(this.startHint, missingPlayersMessage(seated.length));
    // Once the game can start there is nothing to tell: the sentence stays for screen readers, not for the eye.
    this.startHint.classList.toggle('visually-hidden', canStart);
    setDisabled(this.addBotButton, isFull);
    setDisabled(this.removeBotButton, !hasBot);
    setDisabled(this.compactAddButton, isFull);
    setDisabled(this.compactRemoveButton, !hasBot);
  }

  private renderRoster(state: TableView, seated: readonly SeatView[]): void {
    const key = rosterKey(state.seats, state.self.seat);
    if (key === this.renderedRosterKey) return;
    this.renderedRosterKey = key;
    clearChildren(this.roster);
    for (const seat of rosterOrder(seated, state.self.seat)) this.roster.appendChild(createRosterItem(seat, seat.seat === state.self.seat));
    for (let empty = seated.length; empty < MAX_SEATS; empty += 1) this.roster.appendChild(createEmptyRosterItem());
  }

  private bindEvents(): void {
    for (const button of [this.addBotButton, this.compactAddButton]) button.addEventListener('click', () => this.callbacks.onAddBot());
    for (const button of [this.removeBotButton, this.compactRemoveButton]) button.addEventListener('click', () => this.callbacks.onRemoveBot());
    this.startButton.addEventListener('click', () => this.callbacks.onStart(this.readConfig()));
  }

  /** Starts the selectors from the server defaults, then leaves them to the user. */
  private initializeFields(state: TableView): void {
    this.fieldsInitialized = true;
    this.blindsSelector.setValue(`${state.config.smallBlind}/${state.config.bigBlind}`);
    this.stackSelector.setValue(String(state.config.startingStack));
    this.turnSelector.setValue(String(state.config.turnSeconds));
    this.refreshStackOptions();
  }

  private handleBlindsChange(): void {
    const { bigBlind } = this.readBlinds();
    const previous = Number(this.stackSelector.getValue());
    const adjusted = adjustStackForBlinds(previous, bigBlind);
    if (adjusted !== previous) this.stackSelector.setValue(String(adjusted));
    this.refreshStackOptions();
    if (adjusted !== previous) {
      this.showRuleNote(`Fichas ajustadas para ${formatChips(adjusted)}, o mínimo de ${MIN_STACK_IN_BIG_BLINDS} big blinds para estes blinds.`);
    }
  }

  /** Disables the stacks the server would refuse for the chosen blinds and says how many big blinds the chosen one is worth. */
  private refreshStackOptions(): void {
    const { smallBlind, bigBlind } = this.readBlinds();
    const allowed = selectableStacks(bigBlind);
    const minimum = MIN_STACK_IN_BIG_BLINDS * bigBlind;
    for (const stack of STACK_OPTIONS) {
      const refused = !allowed.includes(stack);
      this.stackSelector.setOptionDisabled(String(stack), refused, `Indisponível: com blinds ${smallBlind}/${bigBlind} o mínimo é ${formatChips(minimum)} fichas`);
    }
    const stack = Number(this.stackSelector.getValue());
    this.showRuleNote(describeStackRule(smallBlind, bigBlind) ?? `${formatChips(stack)} fichas valem ${stackInBigBlinds(stack, bigBlind)} big blinds.`);
    this.refreshSettingsSummary();
  }

  private refreshSettingsSummary(): void {
    const { smallBlind, bigBlind } = this.readBlinds();
    setText(this.settingsSummary, describeTableSettings(smallBlind, bigBlind, Number(this.stackSelector.getValue()), Number(this.turnSelector.getValue())));
  }

  private showRuleNote(text: string): void {
    setText(this.ruleNote, text);
  }

  private readBlinds(): { smallBlind: number; bigBlind: number } {
    const [smallBlind, bigBlind] = this.blindsSelector.getValue().split('/').map(Number);
    return { smallBlind, bigBlind };
  }

  private readConfig(): Partial<TableConfig> {
    return {
      ...this.readBlinds(),
      startingStack: Number(this.stackSelector.getValue()),
      turnSeconds: Number(this.turnSelector.getValue()),
    };
  }
}
