import type { TableView } from '../../shared/protocol';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const SAFE_COLOR_PATTERN = /^#[0-9a-f]{3,8}$/i;
const FALLBACK_COLOR = '#e4b363';

export type ElementChild = Node | string | null | undefined | false;

export interface ElementOptions {
  className?: string;
  text?: string;
  attrs?: Record<string, string>;
  dataset?: Record<string, string>;
  /** Applied with setProperty, so both regular properties and custom properties work. */
  style?: Record<string, string>;
}

function appendChildren(parent: Node, children: ElementChild[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
}

/** Builds an element without ever parsing markup, so player-provided text stays inert. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
  ...children: ElementChild[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (options.className) element.className = options.className;
  if (options.text !== undefined) element.textContent = options.text;
  for (const [name, value] of Object.entries(options.attrs ?? {})) element.setAttribute(name, value);
  for (const [name, value] of Object.entries(options.dataset ?? {})) element.dataset[name] = value;
  for (const [name, value] of Object.entries(options.style ?? {})) element.style.setProperty(name, value);
  appendChildren(element, children);
  return element;
}

export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
  ...children: SVGElement[]
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NAMESPACE, tag);
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, String(value));
  appendChildren(element, children);
  return element;
}

export function setText(node: Node, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

export function setHidden(node: HTMLElement, hidden: boolean): void {
  if (node.hidden !== hidden) node.hidden = hidden;
}

export function setData(node: HTMLElement, key: string, value: string): void {
  if (node.dataset[key] !== value) node.dataset[key] = value;
}

export function setDisabled(node: HTMLButtonElement | HTMLInputElement | HTMLSelectElement, disabled: boolean): void {
  if (node.disabled !== disabled) node.disabled = disabled;
}

export function setStyleProperty(node: HTMLElement, name: string, value: string): void {
  if (node.style.getPropertyValue(name) !== value) node.style.setProperty(name, value);
}

export function clearChildren(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Re-triggers a CSS keyframe animation that is bound to a class. */
export function restartAnimation(node: HTMLElement, className: string): void {
  node.classList.remove(className);
  void node.offsetWidth;
  node.classList.add(className);
}

/** Colours arrive from the network; only plain hex values reach a style property. */
export function safeColor(value: string): string {
  return SAFE_COLOR_PATTERN.test(value) ? value : FALLBACK_COLOR;
}

/** totalPot = collected pots + every chip still in front of the players. */
export function computeTotalPot(state: TableView): number {
  const collected = state.pots.reduce((sum, pot) => sum + pot.amount, 0);
  const streetBets = state.seats.reduce((sum, seat) => sum + (seat?.bet ?? 0), 0);
  return collected + streetBets;
}

export type TimerLevel = 'ok' | 'warn' | 'urgent';

export function timerLevel(remainingMs: number, durationMs: number): TimerLevel {
  const ratio = durationMs > 0 ? remainingMs / durationMs : 0;
  if (remainingMs <= 5000 || ratio <= 0.2) return 'urgent';
  if (remainingMs <= 10000 || ratio <= 0.45) return 'warn';
  return 'ok';
}

const clockFormatter = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });

export function formatClock(timestamp: number): string {
  return clockFormatter.format(timestamp);
}

export function readStoredJson(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

export function writeStoredJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or blocked storage: the preference simply is not remembered.
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function copyWithSelection(text: string): boolean {
  const field = el('textarea', {
    attrs: { readonly: '', 'aria-hidden': 'true', tabindex: '-1' },
    style: { position: 'fixed', top: '0', left: '-9999px', 'font-size': '16px', opacity: '0' },
  });
  field.value = text;
  document.body.appendChild(field);
  field.select();
  field.setSelectionRange(0, text.length);
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  field.remove();
  return copied;
}

/** LAN pages are served over plain http, where navigator.clipboard is unavailable, hence the fallback. */
export async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return copyWithSelection(text);
    }
  }
  return copyWithSelection(text);
}

export type IconName =
  | 'scale'
  | 'settings'
  | 'log'
  | 'chevron'
  | 'copy'
  | 'check'
  | 'close'
  | 'spade'
  | 'plus'
  | 'minus'
  | 'bot'
  | 'stopwatch'
  | 'link'
  | 'info'
  | 'chip'
  | 'cards'
  | 'trophy'
  | 'warning'
  | 'bolt'
  | 'play'
  | 'book';

const ICON_PATHS: Record<IconName, string[]> = {
  scale: ['M12 3v17', 'M8 20h8', 'M5 7h14', 'M5 7l-3 7a3.2 3.2 0 0 0 6 0z', 'M19 7l-3 7a3.2 3.2 0 0 0 6 0z'],
  settings: [
    'M12 2.5l1.6 2.3 2.7-.6 1 2.6 2.6 1-.6 2.7 2.2 1.6-2.2 1.6.6 2.7-2.6 1-1 2.6-2.7-.6L12 21.5l-1.6-2.3-2.7.6-1-2.6-2.6-1 .6-2.7L2.5 12l2.2-1.6-.6-2.7 2.6-1 1-2.6 2.7.6z',
    'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  ],
  log: ['M5 4h14v16H5z', 'M8.5 9h7', 'M8.5 13h7', 'M8.5 17h4'],
  chevron: ['M6 9l6 6 6-6'],
  copy: ['M9 9h11v11H9z', 'M5 15V4h11'],
  check: ['M5 13l4 4L19 7'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  spade: ['M12 3c3.5 4.2 7 6.6 7 10a3.6 3.6 0 0 1-6.2 2.5c.2 1.8.9 3.2 2.2 4.5H9.2c1.3-1.3 2-2.7 2.2-4.5A3.6 3.6 0 0 1 5 13c0-3.4 3.5-5.8 7-10z'],
  plus: ['M12 5v14', 'M5 12h14'],
  minus: ['M5 12h14'],
  bot: ['M7 8h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z', 'M12 8V5', 'M9.5 12.5h.01', 'M14.5 12.5h.01', 'M9.5 16h5'],
  stopwatch: ['M12 8a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M12 12v3.5l2.2 1.2', 'M10 3h4', 'M12 3v5'],
  link: ['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1', 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'],
  info: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 11v5', 'M12 8h.01'],
  chip: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z'],
  cards: ['M8 4h9a2 2 0 0 1 2 2v11', 'M5 8h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z'],
  trophy: ['M8 4h8v5a4 4 0 0 1-8 0z', 'M8 6H5v1.5A3 3 0 0 0 8 10.5', 'M16 6h3v1.5a3 3 0 0 1-3 3', 'M12 13v4', 'M9 20h6', 'M10 17h4'],
  warning: ['M12 4l9 16H3z', 'M12 10v4.5', 'M12 17.5h.01'],
  bolt: ['M13 3L5 13.5h6L10 21l8-10.5h-6z'],
  play: ['M8 5l11 7-11 7z'],
  book: ['M4 5.5A1.5 1.5 0 0 1 5.5 4H11v15H5.5A1.5 1.5 0 0 0 4 20.5z', 'M20 5.5A1.5 1.5 0 0 0 18.5 4H13v15h5.5a1.5 1.5 0 0 1 1.5 1.5z'],
};

export function createIcon(name: IconName, size = 20): SVGSVGElement {
  const icon = svgEl('svg', {
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 1.8,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
    class: 'icon',
  });
  for (const pathData of ICON_PATHS[name]) icon.appendChild(svgEl('path', { d: pathData }));
  return icon;
}

export interface ChoiceOption {
  value: string;
  /** Accessible name and tooltip. */
  label: string;
  /** Visible content; defaults to the label. */
  face?: string | Node;
  /** Exposed to CSS as --choice-color (swatches, dots). */
  color?: string;
}

export interface ChoiceGroupConfig {
  name: string;
  ariaLabel: string;
  variant: 'swatch' | 'avatar' | 'segment';
  options: ChoiceOption[];
  value: string;
  onChange?: (value: string) => void;
}

export interface ChoiceGroup {
  readonly element: HTMLElement;
  getValue(): string;
  setValue(value: string): void;
}

/** Native radio inputs under a styled face: keyboard and screen-reader behaviour come for free. */
export function createChoiceGroup(config: ChoiceGroupConfig): ChoiceGroup {
  const element = el('div', {
    className: `choice choice--${config.variant}`,
    attrs: { role: 'radiogroup', 'aria-label': config.ariaLabel },
  });
  const inputs = new Map<string, HTMLInputElement>();

  for (const option of config.options) {
    const input = el('input', {
      className: 'choice__input',
      attrs: { type: 'radio', name: config.name, value: option.value, 'aria-label': option.label },
    });
    const face = el('span', { className: 'choice__face' }, option.face ?? option.label);
    if (option.color) face.style.setProperty('--choice-color', safeColor(option.color));
    element.appendChild(el('label', { className: 'choice__option', attrs: { title: option.label } }, input, face));
    inputs.set(option.value, input);
  }

  const setValue = (value: string): void => {
    const input = inputs.get(value);
    if (input) input.checked = true;
  };
  setValue(config.value);

  element.addEventListener('change', (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.checked) config.onChange?.(target.value);
  });

  return {
    element,
    setValue,
    getValue: () => {
      for (const [value, input] of inputs) if (input.checked) return value;
      return config.value;
    },
  };
}
