import './menuKit.css';
import './lobby.css';
import { PLAYER_AVATARS, PLAYER_COLORS } from '../../shared/protocol';
import type { ManualPanel } from '../manual/ManualPanel';
import {
  clearChildren,
  copyText,
  createIcon,
  el,
  isRecord,
  readStoredJson,
  restartAnimation,
  safeColor,
  setDisabled,
  setHidden,
  setText,
  svgEl,
  writeStoredJson,
} from './dom';
import {
  type Disclosure,
  type Selector,
  createButton,
  createDisclosure,
  createField,
  createSelector,
  nextUniqueId,
  setButtonLabel,
} from './menuKit';

export interface LobbyProfile {
  name: string;
  color: string;
  avatar: string;
}

export interface TableInfo {
  seated: number;
  maxSeats: number;
  running: boolean;
  handNumber: number;
}

const PROFILE_STORAGE_KEY = 'poker-lan.profile';
const MAX_NAME_LENGTH = 16;
const LEAVE_TRANSITION_MS = 260;
const COPY_FEEDBACK_MS = 1800;
const STATUS_NOTICE_MS = 4000;
const JOIN_LABEL = 'Sentar à mesa';
const SPECTATE_LABEL = 'Assistir à mesa';

const COLOR_NAMES: Record<string, string> = {
  '#e4b363': 'Dourado',
  '#e05a47': 'Vermelho',
  '#4fb3a9': 'Turquesa',
  '#6c8cff': 'Azul',
  '#c77dff': 'Violeta',
  '#5fd068': 'Verde',
  '#ff8fab': 'Rosa',
  '#f2f2f2': 'Branco',
};

const LIGHT_CHIP_LUMINANCE = 0.62;
const CHIP_STRIPE_COUNT = 12;
const CHIP_STRIPE_RADIUS = 89;
const CHIP_STRIPE_WIDTH = 18;
const LIGHT_STRIPE = '#eee4cf';
const DARK_STRIPE = '#1a120d';

function pickRandom<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

function loadProfile(): LobbyProfile {
  const stored = readStoredJson(PROFILE_STORAGE_KEY);
  const record = isRecord(stored) ? stored : {};
  const color = typeof record.color === 'string' && PLAYER_COLORS.includes(record.color) ? record.color : pickRandom(PLAYER_COLORS);
  const avatar = typeof record.avatar === 'string' && PLAYER_AVATARS.includes(record.avatar) ? record.avatar : pickRandom(PLAYER_AVATARS);
  const name = typeof record.name === 'string' ? record.name.trim().slice(0, MAX_NAME_LENGTH) : '';
  return { name, color, avatar };
}

function linearChannel(value: number): number {
  const scaled = value / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a #rrggbb colour; anything else counts as mid-tone. */
export function relativeLuminance(hex: string): number {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (match === null) return 0.5;
  const [red, green, blue] = [match[1], match[2], match[3]].map((channel) => linearChannel(Number.parseInt(channel, 16)));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** Ivory stripes read on every chip colour except the near-white one, which needs dark stripes. */
export function chipStripeColor(chipColor: string): string {
  return relativeLuminance(chipColor) >= LIGHT_CHIP_LUMINANCE ? DARK_STRIPE : LIGHT_STRIPE;
}

/** The name is engraved on a half circle: longer names get a smaller type size so they always fit. */
export function chipNameFontSize(nameLength: number): number {
  const fitted = Math.floor(330 / Math.max(nameLength, 1));
  return Math.min(24, Math.max(15, fitted));
}

/** One plain sentence about the table, built from what the server reports. */
export function describeTableStatus(info: TableInfo | null): string {
  if (info === null) return '';
  const { seated, maxSeats, running, handNumber } = info;
  if (seated >= maxSeats) return `${seated} de ${maxSeats} lugares ocupados. Você entra como espectador.`;
  if (seated === 0) return 'Mesa vazia. Você será o primeiro a sentar.';
  const occupancy = `${seated} de ${maxSeats} lugares ocupados`;
  if (!running) return `${occupancy}, partida ainda não começou`;
  return handNumber > 0 ? `${occupancy}, partida em andamento, mão ${handNumber}` : `${occupancy}, partida em andamento`;
}

export function describeInviteLabel(addressCount: number): string {
  return addressCount > 1 ? `Chamar amigos (${addressCount} endereços)` : 'Chamar amigos';
}

interface PlayerChip {
  readonly element: HTMLElement;
  update(profile: LobbyProfile): void;
}

function createCirclePath(id: string, radius: number, direction: 'over' | 'under'): SVGPathElement {
  const sweep = direction === 'over' ? 1 : 0;
  return svgEl('path', { id, d: `M ${100 - radius} 100 A ${radius} ${radius} 0 0 ${sweep} ${100 + radius} 100`, fill: 'none' });
}

function createRimText(pathId: string, className: string, offsetY = 0): { text: SVGTextElement; textPath: SVGTextPathElement } {
  const textPath = svgEl('textPath', { href: `#${pathId}`, startOffset: '50%', 'text-anchor': 'middle' });
  const text = svgEl('text', { class: className, dy: offsetY }, textPath);
  return { text, textPath };
}

/**
 * The bold element of the lobby: a casino chip in the player's colour, avatar in the centre inlay and the
 * name engraved around the rim. Colour is a CSS variable, so changing it never rebuilds the SVG.
 */
function createPlayerChip(): PlayerChip {
  const uid = nextUniqueId();
  const topPathId = `chip-top-${uid}`;
  const bottomPathId = `chip-bottom-${uid}`;
  const circumference = 2 * Math.PI * CHIP_STRIPE_RADIUS;
  const period = circumference / CHIP_STRIPE_COUNT;
  const dash = period * 0.48;

  const engraved = createRimText(topPathId, 'chip__name');
  const highlight = createRimText(topPathId, 'chip__name chip__name--light', 1);
  const legend = createRimText(bottomPathId, 'chip__legend');
  legend.textPath.textContent = 'Mesa Real';

  const svg = svgEl(
    'svg',
    { viewBox: '0 0 200 200', class: 'chip__svg', 'aria-hidden': 'true', focusable: 'false' },
    svgEl(
      'defs',
      {},
      createCirclePath(topPathId, 62, 'over'),
      createCirclePath(bottomPathId, 74, 'under'),
      svgEl(
        'linearGradient',
        { id: `chip-bevel-${uid}`, x1: 0, y1: 0, x2: 1, y2: 1 },
        svgEl('stop', { offset: 0, 'stop-color': '#fff', 'stop-opacity': 0.6 }),
        svgEl('stop', { offset: 0.5, 'stop-color': '#fff', 'stop-opacity': 0 }),
        svgEl('stop', { offset: 1, 'stop-color': '#000', 'stop-opacity': 0.55 }),
      ),
      svgEl(
        'radialGradient',
        { id: `chip-sheen-${uid}`, cx: 0.3, cy: 0.22, r: 0.85 },
        svgEl('stop', { offset: 0, 'stop-color': '#fff', 'stop-opacity': 0.3 }),
        svgEl('stop', { offset: 0.6, 'stop-color': '#fff', 'stop-opacity': 0 }),
      ),
    ),
    svgEl('circle', { class: 'chip__edge', cx: 100, cy: 100, r: 98 }),
    svgEl('circle', {
      class: 'chip__stripes',
      cx: 100,
      cy: 100,
      r: CHIP_STRIPE_RADIUS,
      fill: 'none',
      'stroke-width': CHIP_STRIPE_WIDTH,
      'stroke-dasharray': `${dash.toFixed(2)} ${(period - dash).toFixed(2)}`,
      'stroke-dashoffset': (dash / 2).toFixed(2),
      transform: 'rotate(-90 100 100)',
    }),
    svgEl('circle', { class: 'chip__face', cx: 100, cy: 100, r: 79 }),
    svgEl('circle', { class: 'chip__ring', cx: 100, cy: 100, r: 79, fill: 'none' }),
    svgEl('rect', { class: 'chip__diamond', x: 28.5, y: 96.5, width: 7, height: 7, transform: 'rotate(45 32 100)' }),
    svgEl('rect', { class: 'chip__diamond', x: 164.5, y: 96.5, width: 7, height: 7, transform: 'rotate(45 168 100)' }),
    highlight.text,
    engraved.text,
    legend.text,
    svgEl('circle', { class: 'chip__inlay', cx: 100, cy: 100, r: 55 }),
    svgEl('circle', { cx: 100, cy: 100, r: 98, fill: 'none', stroke: `url(#chip-bevel-${uid})`, 'stroke-width': 3 }),
    svgEl('circle', { cx: 100, cy: 100, r: 98, fill: `url(#chip-sheen-${uid})`, 'pointer-events': 'none' }),
  );

  const avatar = el('span', { className: 'chip__avatar', attrs: { 'aria-hidden': 'true' } });
  const element = el('div', { className: 'chip', attrs: { role: 'img' } }, svg, avatar);

  return {
    element,
    update: (profile) => {
      const color = safeColor(profile.color);
      element.style.setProperty('--chip-color', color);
      element.style.setProperty('--chip-stripe', chipStripeColor(color));
      const name = profile.name.trim();
      const shown = name === '' ? 'Seu nome' : name;
      element.dataset.empty = String(name === '');
      element.setAttribute('aria-label', name === '' ? 'Sua ficha' : `Sua ficha: ${name}`);
      for (const rim of [engraved, highlight]) {
        rim.textPath.textContent = shown;
        rim.text.style.setProperty('font-size', `${chipNameFontSize(shown.length)}px`);
      }
      setText(avatar, profile.avatar);
    },
  };
}

export class Lobby {
  private readonly screen: HTMLElement;
  private readonly nameInput: HTMLInputElement;
  private readonly nameCounter: HTMLElement;
  private readonly nameError: HTMLElement;
  private readonly colorSelector: Selector;
  private readonly avatarSelector: Selector;
  private readonly chip: PlayerChip;
  private readonly submitButton: HTMLButtonElement;
  private readonly statusLine: HTMLElement;
  private readonly tableStatus: HTMLElement;
  private readonly manualSlot: HTMLElement;
  private readonly inviteDisclosure: Disclosure;
  private readonly inviteList: HTMLElement;
  private readonly inviteBox: HTMLElement;
  private renderedUrlsKey = '';
  private tableInfo: TableInfo | null = null;
  private manualButton: HTMLButtonElement | null = null;
  private inviteToggledByUser = false;
  private joining = false;
  private hideTimer: number | null = null;
  private statusTimer: number | null = null;

  constructor(
    root: HTMLElement,
    private readonly onJoin: (profile: LobbyProfile) => Promise<{ ok: boolean; error?: string }>,
  ) {
    root.classList.add('ui-layer', 'ui-layer--lobby');
    const profile = loadProfile();

    this.nameInput = el('input', {
      className: 'mk-input lobby__name-input',
      attrs: {
        id: 'lobby-name',
        type: 'text',
        name: 'player-name',
        maxlength: String(MAX_NAME_LENGTH),
        autocomplete: 'off',
        autocapitalize: 'words',
        spellcheck: 'false',
        enterkeyhint: 'go',
        placeholder: 'Como devemos te chamar?',
        'aria-describedby': 'lobby-name-error',
        'data-qa': 'name-input',
      },
    });
    this.nameInput.value = profile.name;
    this.nameCounter = el('span', { className: 'mk-counter', attrs: { 'aria-hidden': 'true' } });
    this.nameError = el('p', { className: 'mk-error', attrs: { id: 'lobby-name-error', role: 'alert', hidden: '' } });

    this.colorSelector = createSelector({
      name: 'lobby-color',
      ariaLabel: 'Cor da ficha',
      variant: 'swatch',
      value: profile.color,
      options: PLAYER_COLORS.map((color, index) => ({ value: color, label: COLOR_NAMES[color] ?? `Cor ${index + 1}`, face: '', color })),
      onChange: () => this.handleLookChange(),
    });
    this.avatarSelector = createSelector({
      name: 'lobby-avatar',
      ariaLabel: 'Avatar',
      variant: 'avatar',
      value: profile.avatar,
      options: PLAYER_AVATARS.map((avatar) => ({ value: avatar, label: `Avatar ${avatar}`, face: avatar })),
      onChange: () => this.handleLookChange(),
    });
    this.chip = createPlayerChip();

    this.inviteList = el('ul', { className: 'invite__list' });
    this.inviteBox = el('div', {}, el('p', { className: 'mk-hint', text: 'Abra este endereço em outro aparelho no mesmo Wi-Fi.' }), this.inviteList);
    this.inviteDisclosure = createDisclosure({
      label: describeInviteLabel(0),
      icon: 'link',
      content: this.inviteBox,
      open: false,
      onToggle: () => {
        this.inviteToggledByUser = true;
      },
    });
    this.inviteDisclosure.element.classList.add('lobby__invite');
    this.inviteDisclosure.element.hidden = true;

    this.submitButton = createButton({ label: JOIN_LABEL, tone: 'cta', type: 'submit', block: true, qa: 'join' });
    this.statusLine = el('p', { className: 'lobby__status', attrs: { role: 'status', 'aria-live': 'polite', hidden: '' } });
    this.tableStatus = el('p', { className: 'lobby__table-status mk-hint' });
    this.manualSlot = el('span', { className: 'lobby__manual' });

    const form = el(
      'form',
      { className: 'lobby__panel mk-panel', attrs: { novalidate: '', autocomplete: 'off', 'aria-label': 'Seu lugar na mesa' } },
      el(
        'div',
        { className: 'lobby__fields' },
        el(
          'div',
          { className: 'lobby__identity' },
          this.chip.element,
          createField('Seu nome na mesa', this.nameInput, { forId: 'lobby-name', trailing: this.nameCounter, hint: this.nameError }),
        ),
        createField('Cor da ficha', this.colorSelector.element),
        createField('Avatar', this.avatarSelector.element),
        this.inviteDisclosure.element,
      ),
      el(
        'div',
        { className: 'lobby__footer' },
        this.statusLine,
        this.submitButton,
        el('div', { className: 'lobby__meta' }, this.tableStatus, this.manualSlot),
      ),
    );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.handleSubmit();
    });
    this.nameInput.addEventListener('input', () => this.handleNameInput());

    this.screen = el(
      'section',
      { className: 'lobby', attrs: { 'aria-label': 'Entrar na mesa' } },
      el(
        'div',
        { className: 'lobby__layout' },
        el(
          'header',
          { className: 'lobby__brand' },
          el('h1', { className: 'lobby__title', text: 'Mesa Real' }),
          el('p', { className: 'lobby__subtitle', text: "Texas Hold'em entre amigos, na sua rede" }),
        ),
        form,
      ),
    );
    root.appendChild(this.screen);

    this.refreshPreview();
    this.renderTableStatus();
    this.show();
  }

  show(): void {
    if (this.hideTimer !== null) {
      window.clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    this.screen.hidden = false;
    this.screen.classList.remove('is-leaving');
    if (!this.nameInput.value && window.matchMedia('(pointer: fine)').matches) this.nameInput.focus();
  }

  hide(): void {
    this.screen.classList.add('is-leaving');
    if (this.hideTimer !== null) window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => {
      this.screen.hidden = true;
      this.hideTimer = null;
    }, LEAVE_TRANSITION_MS);
  }

  setLanUrls(urls: string[]): void {
    const key = urls.join('\n');
    if (key === this.renderedUrlsKey) return;
    this.renderedUrlsKey = key;
    clearChildren(this.inviteList);
    for (const url of urls) this.inviteList.appendChild(this.createInviteRow(url));
    this.inviteDisclosure.setLabel(describeInviteLabel(urls.length));
    setHidden(this.inviteDisclosure.element, urls.length === 0);
    if (!this.inviteToggledByUser) this.inviteDisclosure.setOpen(urls.length > 0 && window.matchMedia('(min-width: 1024px) and (min-height: 900px)').matches);
  }

  /** Errors and work in progress ("Entrando…") stay until replaced; a plain notice fades after a few seconds. */
  setStatus(text: string, tone: 'info' | 'error' = 'info'): void {
    if (this.statusTimer !== null) window.clearTimeout(this.statusTimer);
    this.statusTimer = null;
    setText(this.statusLine, text);
    this.statusLine.dataset.tone = tone;
    setHidden(this.statusLine, text === '');
    if (tone === 'info' && text !== '' && !text.endsWith('…')) {
      this.statusTimer = window.setTimeout(() => this.setStatus(''), STATUS_NOTICE_MS);
    }
  }

  setManual(manual: ManualPanel): void {
    this.manualButton?.remove();
    const button = manual.createOpenButton({ label: 'Como jogar?' });
    button.dataset.qa = 'manual-open';
    this.manualButton = button;
    this.manualSlot.appendChild(button);
  }

  setTableInfo(info: TableInfo): void {
    this.tableInfo = info;
    this.renderTableStatus();
  }

  private renderTableStatus(): void {
    const text = describeTableStatus(this.tableInfo);
    setText(this.tableStatus, text);
    setHidden(this.tableStatus, text === '');
    if (!this.joining) setButtonLabel(this.submitButton, this.idleSubmitLabel());
  }

  private idleSubmitLabel(): string {
    const full = this.tableInfo !== null && this.tableInfo.seated >= this.tableInfo.maxSeats;
    return full ? SPECTATE_LABEL : JOIN_LABEL;
  }

  private currentProfile(): LobbyProfile {
    return { name: this.nameInput.value.trim().slice(0, MAX_NAME_LENGTH), color: this.colorSelector.getValue(), avatar: this.avatarSelector.getValue() };
  }

  private refreshPreview(): void {
    this.chip.update(this.currentProfile());
    setText(this.nameCounter, `${this.nameInput.value.trim().length}/${MAX_NAME_LENGTH}`);
  }

  private handleNameInput(): void {
    this.refreshPreview();
    this.showNameError(null);
  }

  /** The chip turns over when the player changes what it looks like, so the change reads as an answer. */
  private handleLookChange(): void {
    this.refreshPreview();
    restartAnimation(this.chip.element, 'is-flipping');
  }

  private showNameError(message: string | null): void {
    setText(this.nameError, message ?? '');
    setHidden(this.nameError, message === null);
    if (message === null) this.nameInput.removeAttribute('aria-invalid');
    else this.nameInput.setAttribute('aria-invalid', 'true');
  }

  private async handleSubmit(): Promise<void> {
    if (this.joining) return;
    const profile = this.currentProfile();
    if (profile.name === '') {
      this.showNameError('Digite um nome para sentar à mesa.');
      this.nameInput.focus();
      return;
    }

    writeStoredJson(PROFILE_STORAGE_KEY, profile);
    this.setJoining(true);
    this.setStatus('Entrando na mesa…');
    try {
      const result = await this.onJoin(profile);
      if (result.ok) this.setStatus('');
      else this.setStatus(result.error ?? 'Não foi possível entrar na mesa. Tente de novo em instantes.', 'error');
    } catch {
      this.setStatus('Sem conexão com o servidor. Confira o Wi-Fi e tente de novo.', 'error');
    } finally {
      this.setJoining(false);
    }
  }

  private setJoining(joining: boolean): void {
    this.joining = joining;
    setDisabled(this.submitButton, joining);
    setButtonLabel(this.submitButton, joining ? 'Entrando…' : this.idleSubmitLabel());
  }

  private createInviteRow(url: string): HTMLElement {
    const label = el('span', { className: 'mk-btn__label', text: 'Copiar' });
    const button = el(
      'button',
      { className: 'mk-btn mk-btn--small', attrs: { type: 'button', 'aria-label': `Copiar endereço ${url}` } },
      createIcon('copy', 16),
      label,
    );
    let feedbackTimer: number | null = null;
    button.addEventListener('click', () => {
      void copyText(url).then((copied) => {
        setText(label, copied ? 'Copiado!' : 'Copie à mão');
        button.dataset.state = copied ? 'done' : 'failed';
        if (feedbackTimer !== null) window.clearTimeout(feedbackTimer);
        feedbackTimer = window.setTimeout(() => {
          setText(label, 'Copiar');
          delete button.dataset.state;
        }, COPY_FEEDBACK_MS);
      });
    });
    return el('li', { className: 'invite__row' }, el('span', { className: 'invite__url', text: url }), button);
  }
}
