import './menuKit.css';
import type { SeatView } from '../../shared/protocol';
import { clamp, createIcon, el, safeColor, setHidden, setStyleProperty, setText, type IconName } from './dom';

export type ButtonTone = 'default' | 'cta' | 'danger' | 'ghost-danger';

export interface ButtonOptions {
  label: string;
  tone?: ButtonTone;
  icon?: IconName;
  /** Stable hook for the headless QA script (data-qa). */
  qa?: string;
  type?: 'button' | 'submit';
  block?: boolean;
  small?: boolean;
  title?: string;
  ariaLabel?: string;
}

export function createButton(options: ButtonOptions): HTMLButtonElement {
  const classes = ['mk-btn'];
  if (options.tone === 'cta') classes.push('mk-btn--cta');
  if (options.tone === 'danger') classes.push('mk-btn--danger');
  if (options.tone === 'ghost-danger') classes.push('mk-btn--ghost-danger');
  if (options.block) classes.push('mk-btn--block');
  if (options.small) classes.push('mk-btn--small');

  const attrs: Record<string, string> = { type: options.type ?? 'button' };
  if (options.qa) attrs['data-qa'] = options.qa;
  if (options.title) attrs.title = options.title;
  if (options.ariaLabel) attrs['aria-label'] = options.ariaLabel;

  return el(
    'button',
    { className: classes.join(' '), attrs },
    options.icon ? createIcon(options.icon, 18) : null,
    el('span', { className: 'mk-btn__label', text: options.label }),
  );
}

export function setButtonLabel(button: HTMLButtonElement, label: string): void {
  const labelNode = button.querySelector('.mk-btn__label');
  if (labelNode) setText(labelNode, label);
}

/* ---------- Option selectors ---------- */

export type SelectorVariant = 'token' | 'segment' | 'swatch' | 'avatar';

export interface SelectorOption {
  value: string;
  /** Accessible name and tooltip. */
  label: string;
  /** Visible content of the token; defaults to the label. */
  face?: string | Node;
  /** Short text under the token. */
  caption?: string;
  /** Exposed to CSS as --choice-color. */
  color?: string;
  /** Pairs of chips need a wider face than a single round token. */
  wide?: boolean;
}

export interface SelectorConfig {
  name: string;
  ariaLabel: string;
  variant: SelectorVariant;
  options: SelectorOption[];
  value: string;
  onChange?: (value: string) => void;
}

export interface Selector {
  readonly element: HTMLElement;
  getValue(): string;
  setValue(value: string): void;
  setOptionDisabled(value: string, disabled: boolean, reason?: string): void;
  /** Only options created with a caption (even an empty one) have a caption line to update. */
  setOptionCaption(value: string, caption: string): void;
}

interface SelectorEntry {
  input: HTMLInputElement;
  label: HTMLElement;
  caption: HTMLElement | null;
  title: string;
}

/** Native radio inputs under a styled face: keyboard and screen-reader behaviour come for free. */
export function createSelector(config: SelectorConfig): Selector {
  const element = el('div', {
    className: `mk-options mk-options--${config.variant}`,
    attrs: { role: 'radiogroup', 'aria-label': config.ariaLabel },
  });
  const entries = new Map<string, SelectorEntry>();

  for (const option of config.options) {
    const input = el('input', {
      className: 'mk-option__input',
      attrs: { type: 'radio', name: config.name, value: option.value, 'aria-label': option.label },
    });
    const faceContent = option.face ?? option.label;
    const face = el(
      'span',
      { className: `mk-option__face${option.wide ? ' mk-option__face--pair' : ''}` },
      typeof faceContent === 'string' ? el('span', { text: faceContent }) : faceContent,
    );
    if (option.color) face.style.setProperty('--choice-color', safeColor(option.color));
    const check = el('span', { className: 'mk-option__check', attrs: { 'aria-hidden': 'true' } }, createIcon('check', 12));
    const caption = option.caption === undefined ? null : el('span', { className: 'mk-option__caption', text: option.caption });
    const label = el('label', { className: 'mk-option', attrs: { title: option.label } }, input, face, check, caption);
    element.appendChild(label);
    entries.set(option.value, { input, label, caption, title: option.label });
  }

  const setValue = (value: string): void => {
    const entry = entries.get(value);
    if (entry) entry.input.checked = true;
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
      for (const [value, entry] of entries) if (entry.input.checked) return value;
      return config.value;
    },
    setOptionDisabled: (value, disabled, reason) => {
      const entry = entries.get(value);
      if (!entry) return;
      entry.input.disabled = disabled;
      entry.label.dataset.disabled = String(disabled);
      entry.label.title = disabled && reason ? reason : entry.title;
    },
    setOptionCaption: (value, caption) => {
      const entry = entries.get(value);
      if (entry?.caption) setText(entry.caption, caption);
    },
  };
}

/** A round chip with edge stripes and a short value, drawn in CSS so it stays crisp at any size. */
export function createMiniChip(label: string, color: string, large = false): HTMLElement {
  return el(
    'span',
    {
      className: `mk-minichip${large ? ' mk-minichip--large' : ''}`,
      attrs: { 'aria-hidden': 'true' },
      style: { '--chip': safeColor(color) },
    },
    el('span', { text: label }),
  );
}

/* ---------- Fields, toggles and sliders ---------- */

export interface FieldOptions {
  /** Id of the control the label belongs to; without it the field is a fieldset-like group. */
  forId?: string;
  /** Shown at the end of the label row (a counter, a live value). */
  trailing?: Node;
  hint?: Node;
}

export function createField(label: string, control: Node, options: FieldOptions = {}): HTMLElement {
  const labelNode =
    options.forId === undefined
      ? el('span', { className: 'mk-label', text: label })
      : el('label', { className: 'mk-label', text: label, attrs: { for: options.forId } });
  return el(
    'div',
    { className: 'mk-field' },
    el('div', { className: 'mk-field__head' }, labelNode, options.trailing),
    control,
    options.hint,
  );
}

export interface ToggleRow {
  readonly element: HTMLElement;
  readonly input: HTMLInputElement;
}

export function createToggleRow(label: string, onChange: (checked: boolean) => void, description?: string): ToggleRow {
  const input = el('input', { className: 'mk-toggle__input', attrs: { type: 'checkbox', role: 'switch' } });
  input.addEventListener('change', () => onChange(input.checked));
  const element = el(
    'label',
    { className: 'mk-toggle' },
    el(
      'span',
      { className: 'mk-toggle__text' },
      el('span', { className: 'mk-label', text: label }),
      description === undefined ? null : el('span', { className: 'mk-hint', text: description }),
    ),
    input,
    el('span', { className: 'mk-toggle__track', attrs: { 'aria-hidden': 'true' } }, el('span', { className: 'mk-toggle__thumb' })),
  );
  return { element, input };
}

export interface SliderConfig {
  min: number;
  max: number;
  step: number;
  value: number;
}

export interface SliderRow {
  readonly element: HTMLElement;
  readonly input: HTMLInputElement;
  setValue(value: number): void;
}

/** Fraction of the track that the brass fill covers; also tolerates a degenerate range. */
export function sliderFillPercent(value: number, min: number, max: number): number {
  if (max <= min) return 0;
  return clamp(((value - min) / (max - min)) * 100, 0, 100);
}

export function createSliderRow(
  label: string,
  config: SliderConfig,
  formatValue: (value: number) => string,
  onInput: (value: number) => void,
): SliderRow {
  const output = el('output', { className: 'mk-slider__value' });
  const input = el('input', {
    className: 'mk-slider__input',
    attrs: { type: 'range', min: String(config.min), max: String(config.max), step: String(config.step), 'aria-label': label },
  });
  const paint = (): void => {
    const value = Number(input.value);
    setText(output, formatValue(value));
    setStyleProperty(input, '--fill', `${sliderFillPercent(value, config.min, config.max).toFixed(2)}%`);
  };
  const setValue = (value: number): void => {
    input.value = String(value);
    paint();
  };
  input.addEventListener('input', () => {
    paint();
    onInput(Number(input.value));
  });
  setValue(config.value);

  const element = el(
    'div',
    { className: 'mk-slider' },
    el('div', { className: 'mk-slider__head' }, el('span', { className: 'mk-label', text: label }), output),
    input,
  );
  return { element, input, setValue };
}

/* ---------- Disclosure and inline confirmation ---------- */

export interface DisclosureOptions {
  label: string;
  icon?: IconName;
  content: HTMLElement;
  open?: boolean;
  onToggle?: (open: boolean) => void;
}

export interface Disclosure {
  readonly element: HTMLElement;
  isOpen(): boolean;
  setOpen(open: boolean): void;
  setLabel(label: string): void;
}

export function createDisclosure(options: DisclosureOptions): Disclosure {
  const labelNode = el('span', { className: 'mk-disclosure__label', text: options.label });
  const contentId = `mk-disclosure-${nextUniqueId()}`;
  const toggle = el(
    'button',
    { className: 'mk-disclosure__toggle', attrs: { type: 'button', 'aria-expanded': 'false', 'aria-controls': contentId } },
    options.icon ? createIcon(options.icon, 18) : null,
    labelNode,
    el('span', { className: 'mk-disclosure__chevron' }, createIcon('chevron', 18)),
  );
  options.content.id = contentId;
  options.content.classList.add('mk-disclosure__content');
  const element = el('div', { className: 'mk-disclosure', dataset: { open: 'false' } }, toggle, options.content);

  let open = false;
  const setOpen = (next: boolean): void => {
    open = next;
    element.dataset.open = String(next);
    toggle.setAttribute('aria-expanded', String(next));
    setHidden(options.content, !next);
  };
  toggle.addEventListener('click', () => {
    setOpen(!open);
    options.onToggle?.(open);
  });
  setOpen(options.open === true);

  return { element, isOpen: () => open, setOpen, setLabel: (label) => setText(labelNode, label) };
}

export interface InlineConfirmOptions {
  label: string;
  prompt: string;
  confirmLabel: string;
  cancelLabel?: string;
  icon?: IconName;
  onConfirm: () => void;
}

export interface InlineConfirm {
  readonly element: HTMLElement;
  reset(): void;
}

/** A destructive action asks again in place: no modal, and the safe answer takes the focus. */
export function createInlineConfirm(options: InlineConfirmOptions): InlineConfirm {
  const trigger = createButton({ label: options.label, tone: 'ghost-danger', icon: options.icon, block: true });
  const cancel = createButton({ label: options.cancelLabel ?? 'Cancelar' });
  const confirm = createButton({ label: options.confirmLabel, tone: 'danger' });
  const asking = el(
    'div',
    { className: 'mk-confirm', attrs: { role: 'group', 'aria-label': options.prompt, hidden: '' } },
    el('p', { className: 'mk-confirm__prompt', text: options.prompt }),
    el('div', { className: 'mk-confirm__actions' }, cancel, confirm),
  );
  const element = el('div', { className: 'mk-confirm-root' }, trigger, asking);

  const reset = (): void => {
    setHidden(asking, true);
    setHidden(trigger, false);
  };
  trigger.addEventListener('click', () => {
    setHidden(trigger, true);
    setHidden(asking, false);
    cancel.focus();
  });
  cancel.addEventListener('click', () => {
    reset();
    trigger.focus();
  });
  confirm.addEventListener('click', () => {
    reset();
    options.onConfirm();
  });

  return { element, reset };
}

const knownPlayerColors = new Map<string, string>();
let playerColorVersion = 0;

/**
 * The waiting room sees every table update, so it tells the ledger which colour each name wears at the table
 * (hand summaries only carry names). Kept here, in the shared kit, so the two panels never need to know each other.
 */
export function rememberPlayerColors(seats: readonly (SeatView | null)[]): void {
  for (const seat of seats) {
    if (seat === null || knownPlayerColors.get(seat.name) === seat.color) continue;
    knownPlayerColors.set(seat.name, seat.color);
    playerColorVersion += 1;
  }
}

export function playerColorOf(name: string): string | null {
  return knownPlayerColors.get(name) ?? null;
}

/** Changes whenever a colour was learned, so a panel can tell that what it drew is out of date. */
export function playerColorsVersion(): number {
  return playerColorVersion;
}

let uniqueCounter = 0;

/** Ids for aria-controls and SVG references; one counter keeps them unique across every menu. */
export function nextUniqueId(): number {
  uniqueCounter += 1;
  return uniqueCounter;
}
