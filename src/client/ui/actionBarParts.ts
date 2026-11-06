import { createActionIcon, type ActionIconName } from './actionIcons';
import {
  PRE_ACTION_KINDS,
  PRE_ACTION_LABELS,
  RAISE_PRESET_KEYS,
  describePreAction,
  type ActionButtonModel,
  type PreActionKind,
  type RaisePresetKey,
} from './actionLogic';
import { el, setHidden, setText } from './dom';

export const RAISE_CONTROLS_ID = 'action-raise-controls';
const ICON_SIZE = 18;

export interface ActionButton {
  element: HTMLButtonElement;
  icon: HTMLElement;
  iconName: ActionIconName;
  caption: HTMLElement;
  headline: HTMLElement;
  details: HTMLElement[];
}

export interface PresetToken {
  element: HTMLButtonElement;
  name: HTMLElement;
  value: HTMLElement;
}

export interface RaiseDrawer {
  panel: HTMLElement;
  inner: HTMLElement;
  tokens: Map<RaisePresetKey, PresetToken>;
  ticks: Map<RaisePresetKey, HTMLElement>;
  slider: HTMLInputElement;
  amountInput: HTMLInputElement;
  bigBlindReadout: HTMLElement;
  shareReadout: HTMLElement;
  minusButton: HTMLButtonElement;
  plusButton: HTMLButtonElement;
}

export interface PreActionPanel {
  element: HTMLElement;
  buttons: Map<PreActionKind, HTMLButtonElement>;
  hint: HTMLElement;
}

export interface BarHead {
  element: HTMLElement;
  status: HTMLElement;
  hand: HTMLElement;
  seconds: HTMLElement;
}

export function createActionButton(kind: string, shortcut: string, iconName: ActionIconName, title: string): ActionButton {
  const icon = el('span', { className: 'action-btn__icon' }, createActionIcon(iconName, ICON_SIZE));
  const caption = el('span', { className: 'action-btn__caption' });
  const headline = el('span', { className: 'action-btn__headline' });
  const details = [el('span', { className: 'action-btn__detail' }), el('span', { className: 'action-btn__detail' })];
  const element = el(
    'button',
    { className: `action-btn action-btn--${kind}`, attrs: { type: 'button', title, 'aria-keyshortcuts': shortcut } },
    el('span', { className: 'action-btn__top' }, icon, caption),
    headline,
    el('span', { className: 'action-btn__details' }, ...details),
    el('kbd', { className: 'action-btn__key', text: shortcut, attrs: { 'aria-hidden': 'true' } }),
  );
  return { element, icon, iconName, caption, headline, details };
}

export function setButtonIcon(button: ActionButton, name: ActionIconName): void {
  if (button.iconName === name) return;
  button.iconName = name;
  button.icon.replaceChildren(createActionIcon(name, ICON_SIZE));
}

export function paintActionButton(button: ActionButton, model: ActionButtonModel): void {
  setText(button.caption, model.caption);
  setText(button.headline, model.headline);
  button.details.forEach((node, index) => {
    const text = model.details[index] ?? '';
    setText(node, text);
    setHidden(node, text === '');
  });
  if (button.element.getAttribute('aria-label') !== model.spoken) button.element.setAttribute('aria-label', model.spoken);
}

export function createPresetToken(key: RaisePresetKey): PresetToken {
  const name = el('span', { className: 'raise-token__name' });
  const value = el('span', { className: 'raise-token__value' });
  const element = el('button', { className: 'raise-token', attrs: { type: 'button', 'aria-pressed': 'false' }, dataset: { preset: key } }, name, value);
  return { element, name, value };
}

export function createStepper(iconName: ActionIconName, label: string): HTMLButtonElement {
  return el('button', { className: 'raise-stepper', attrs: { type: 'button', 'aria-label': label, title: label } }, createActionIcon(iconName, ICON_SIZE));
}

export function createRaiseDrawer(): RaiseDrawer {
  const tokens = new Map<RaisePresetKey, PresetToken>();
  const ticks = new Map<RaisePresetKey, HTMLElement>();
  const tokenRow = el('div', { className: 'raise-presets', attrs: { role: 'group', 'aria-label': 'Valores rápidos' } });
  const tickLayer = el('div', { className: 'raise-slider__ticks', attrs: { 'aria-hidden': 'true' } });
  for (const key of RAISE_PRESET_KEYS) {
    const token = createPresetToken(key);
    tokens.set(key, token);
    tokenRow.appendChild(token.element);
    const tick = el('span', { className: 'raise-slider__tick', dataset: { preset: key } });
    ticks.set(key, tick);
    tickLayer.appendChild(tick);
  }

  const slider = el('input', {
    className: 'raise-slider__input',
    attrs: { type: 'range', min: '0', max: '0', step: '1', value: '0', 'aria-label': 'Valor da aposta' },
  });
  const amountInput = el('input', {
    className: 'amount-field__input',
    attrs: {
      type: 'text',
      inputmode: 'numeric',
      pattern: '[0-9]*',
      maxlength: '9',
      autocomplete: 'off',
      'aria-label': 'Valor em fichas',
      'aria-keyshortcuts': 'R',
    },
  });
  const bigBlindReadout = el('span', { className: 'raise-readout__fact' });
  const shareReadout = el('span', { className: 'raise-readout__fact' });
  const minusButton = createStepper('minus', 'Diminuir uma blind grande');
  const plusButton = createStepper('plus', 'Aumentar uma blind grande');

  const inner = el(
    'div',
    { className: 'action-bar__raise-inner', attrs: { role: 'group', 'aria-label': 'Valor do aumento' } },
    tokenRow,
    el(
      'div',
      { className: 'raise-amount' },
      el(
        'div',
        { className: 'raise-amount__value' },
        el('label', { className: 'amount-field' }, amountInput, el('span', { className: 'amount-field__unit', text: 'fichas' })),
        el('div', { className: 'raise-readout' }, bigBlindReadout, shareReadout),
      ),
      el('div', { className: 'raise-steppers' }, minusButton, plusButton),
    ),
    el('div', { className: 'raise-slider' }, tickLayer, slider),
  );
  const panel = el('div', { className: 'action-bar__raise', dataset: { open: 'false' }, attrs: { id: RAISE_CONTROLS_ID } }, inner);
  return { panel, inner, tokens, ticks, slider, amountInput, bigBlindReadout, shareReadout, minusButton, plusButton };
}

export function createPreActionPanel(): PreActionPanel {
  const buttons = new Map<PreActionKind, HTMLButtonElement>();
  const row = el('div', { className: 'preaction-row', attrs: { role: 'group', 'aria-label': 'Jogar automaticamente na sua vez' } });
  for (const kind of PRE_ACTION_KINDS) {
    const button = el(
      'button',
      { className: 'preaction', attrs: { type: 'button', 'aria-pressed': 'false', title: describePreAction(kind) }, dataset: { preaction: kind } },
      el('span', { className: 'preaction__mark' }, createActionIcon('check', 14)),
      el('span', { className: 'preaction__label', text: PRE_ACTION_LABELS[kind] }),
    );
    buttons.set(kind, button);
    row.appendChild(button);
  }
  const hint = el('p', { className: 'preaction-hint' });
  return { element: el('div', { className: 'action-bar__preactions', attrs: { hidden: '' } }, row, hint), buttons, hint };
}

export function createHead(): BarHead {
  const status = el('span', { className: 'action-bar__status' });
  // Compact layouts have no room for the floating hand chip, so the hand name lives in the head instead.
  const hand = el('span', { className: 'action-bar__hand', attrs: { hidden: '', title: 'Sua mão' } });
  const seconds = el('span', { className: 'action-bar__seconds', attrs: { 'aria-hidden': 'true' } });
  return { element: el('div', { className: 'action-bar__head' }, status, hand, seconds), status, hand, seconds };
}
