import './menuKit.css';
import './settingsPanel.css';
import type { AudioManager, VoiceMode } from '../audio/AudioManager';
import { clearChildren, createIcon, el, isRecord, readStoredJson, setDisabled, setHidden, writeStoredJson } from './dom';
import {
  type InlineConfirm,
  type Selector,
  type SliderRow,
  type ToggleRow,
  createButton,
  createField,
  createInlineConfirm,
  createSelector,
  createSliderRow,
  createToggleRow,
} from './menuKit';

export type DisplayQuality = 'high' | 'low';
export type FeltThemeName = 'emerald' | 'royal' | 'burgundy';

export interface SettingsCallbacks {
  onQualityChange(quality: DisplayQuality): void;
  onFeltThemeChange(theme: FeltThemeName): void;
  onLeave(): void;
}

const DISPLAY_STORAGE_KEY = 'poker-lan.display';
const DEFAULT_QUALITY: DisplayQuality = 'high';
const DEFAULT_FELT_THEME: FeltThemeName = 'emerald';
const VOICE_SAMPLE = 'Cartas na mesa. Boa sorte a todos!';
const AUTOMATIC_VOICE_LABEL = 'Automática, em português';

const FELT_OPTIONS: { value: FeltThemeName; label: string; color: string }[] = [
  { value: 'emerald', label: 'Esmeralda', color: '#0f5e45' },
  { value: 'royal', label: 'Azul royal', color: '#123a6b' },
  { value: 'burgundy', label: 'Bordô', color: '#5a1622' },
];

const VOICE_MODE_OPTIONS: { value: VoiceMode; label: string }[] = [
  { value: 'full', label: 'Completa' },
  { value: 'essential', label: 'Essencial' },
  { value: 'off', label: 'Desligada' },
];

interface DisplayPreferences {
  quality: DisplayQuality;
  felt: FeltThemeName;
}

function loadDisplayPreferences(): DisplayPreferences {
  const stored = readStoredJson(DISPLAY_STORAGE_KEY);
  const record = isRecord(stored) ? stored : {};
  const quality = record.quality === 'low' || record.quality === 'high' ? record.quality : DEFAULT_QUALITY;
  const felt = FELT_OPTIONS.find((option) => option.value === record.felt)?.value ?? DEFAULT_FELT_THEME;
  return { quality, felt };
}

function createSection(title: string, ...children: HTMLElement[]): HTMLElement {
  return el('section', { className: 'settings__section' }, el('h3', { className: 'mk-heading', text: title }), ...children);
}

function formatRate(value: number): string {
  return `${value.toFixed(2).replace('.', ',')}×`;
}

export class SettingsPanel {
  readonly element: HTMLElement;
  private readonly gearButton: HTMLButtonElement;
  private readonly popover: HTMLElement;
  private readonly masterRow: SliderRow;
  private readonly rateRow: SliderRow;
  private readonly effectsRow: ToggleRow;
  private readonly ambienceRow: ToggleRow;
  private readonly voiceModeSelector: Selector;
  private readonly voiceSelect: HTMLSelectElement;
  private readonly testVoiceButton: HTMLButtonElement;
  private readonly qualitySelector: Selector;
  private readonly feltSelector: Selector;
  private readonly leaveConfirm: InlineConfirm;
  private open = false;
  private renderedVoicesKey = '';

  private readonly handleOutsidePointer = (event: PointerEvent): void => {
    if (event.target instanceof Node && !this.element.contains(event.target)) this.setOpen(false);
  };
  private readonly handleEscape = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    this.setOpen(false);
    this.gearButton.focus();
  };
  private readonly handleFocusOut = (event: FocusEvent): void => {
    if (event.relatedTarget instanceof Node && !this.element.contains(event.relatedTarget)) this.setOpen(false);
  };

  constructor(
    private readonly callbacks: SettingsCallbacks,
    private readonly audio: AudioManager,
  ) {
    const preferences = loadDisplayPreferences();

    this.gearButton = el(
      'button',
      {
        className: 'mk-icon-btn',
        attrs: { type: 'button', 'aria-label': 'Configurações', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': 'settings-popover' },
      },
      createIcon('settings', 18),
    );
    this.gearButton.addEventListener('click', () => this.setOpen(!this.open));

    this.masterRow = createSliderRow('Volume', { min: 0, max: 100, step: 1, value: 100 }, (value) => `${Math.round(value)}%`, (value) =>
      this.audio.setSettings({ master: value / 100 }),
    );
    this.effectsRow = createToggleRow('Efeitos sonoros', (checked) => this.audio.setSettings({ sfx: checked }));
    this.ambienceRow = createToggleRow('Som ambiente', (checked) => this.audio.setSettings({ ambience: checked }));

    this.voiceModeSelector = createSelector({
      name: 'settings-voice-mode',
      ariaLabel: 'Narração do Juiz',
      variant: 'segment',
      value: 'full',
      options: VOICE_MODE_OPTIONS,
      onChange: (value) => this.handleVoiceModeChange(value as VoiceMode),
    });
    this.voiceSelect = el('select', { className: 'mk-input mk-select settings__voice', attrs: { id: 'settings-voice', 'aria-label': 'Voz da narração' } });
    this.voiceSelect.addEventListener('change', () => this.audio.setSettings({ voiceURI: this.voiceSelect.value === '' ? null : this.voiceSelect.value }));
    this.testVoiceButton = createButton({ label: 'Testar voz', icon: 'play', small: true });
    this.testVoiceButton.addEventListener('click', () => this.audio.speak(VOICE_SAMPLE, 1));
    this.rateRow = createSliderRow('Velocidade da voz', { min: 0.5, max: 2, step: 0.05, value: 1 }, formatRate, (value) =>
      this.audio.setSettings({ voiceRate: value }),
    );

    this.qualitySelector = createSelector({
      name: 'settings-quality',
      ariaLabel: 'Qualidade da imagem',
      variant: 'segment',
      value: preferences.quality,
      options: [
        { value: 'high', label: 'Alta' },
        { value: 'low', label: 'Baixa' },
      ],
      onChange: (value) => this.applyQuality(value === 'low' ? 'low' : 'high'),
    });
    this.feltSelector = createSelector({
      name: 'settings-felt',
      ariaLabel: 'Cor do feltro',
      variant: 'swatch',
      value: preferences.felt,
      options: FELT_OPTIONS.map((option) => ({ value: option.value, label: option.label, face: '', color: option.color, caption: option.label })),
      onChange: (value) => this.applyFelt(value as FeltThemeName),
    });

    this.leaveConfirm = createInlineConfirm({
      label: 'Sair da mesa',
      prompt: 'Sair agora libera o seu lugar na mesa.',
      confirmLabel: 'Sair da mesa',
      onConfirm: () => {
        this.setOpen(false);
        this.callbacks.onLeave();
      },
    });

    const closeButton = el('button', { className: 'mk-icon-btn settings__close', attrs: { type: 'button', 'aria-label': 'Fechar configurações' } }, createIcon('close', 18));
    closeButton.addEventListener('click', () => {
      this.setOpen(false);
      this.gearButton.focus();
    });

    this.popover = el(
      'div',
      { className: 'settings__popover mk-panel mk-panel--compact', attrs: { id: 'settings-popover', role: 'dialog', 'aria-label': 'Configurações', hidden: '' } },
      el('header', { className: 'settings__head' }, el('h2', { className: 'mk-title', text: 'Configurações' }), closeButton),
      el(
        'div',
        { className: 'settings__scroll' },
        createSection('Som', this.masterRow.element, this.effectsRow.element, this.ambienceRow.element),
        createSection(
          'Narração do Juiz',
          this.voiceModeSelector.element,
          createField('Voz', el('div', { className: 'settings__voice-row' }, this.voiceSelect, this.testVoiceButton), { forId: 'settings-voice' }),
          this.rateRow.element,
        ),
        createSection('Imagem', createField('Qualidade', this.qualitySelector.element), createField('Cor do feltro', this.feltSelector.element)),
        createSection('Mesa', this.leaveConfirm.element),
      ),
    );
    this.element = el('div', { className: 'settings' }, this.gearButton, this.popover);

    this.syncFromAudio();
    this.refreshVoices();
    if ('speechSynthesis' in window) window.speechSynthesis.addEventListener('voiceschanged', () => this.refreshVoices());
    this.applyStoredPreferences(preferences);
  }

  dispose(): void {
    this.setOpen(false);
  }

  /** Non-default display choices are pushed to the scene once, so a reload keeps the player's look. */
  private applyStoredPreferences(preferences: DisplayPreferences): void {
    if (preferences.quality !== DEFAULT_QUALITY) this.callbacks.onQualityChange(preferences.quality);
    if (preferences.felt !== DEFAULT_FELT_THEME) this.callbacks.onFeltThemeChange(preferences.felt);
  }

  private handleVoiceModeChange(mode: VoiceMode): void {
    this.audio.setSettings({ voice: mode });
    this.syncVoiceControls(mode);
  }

  /** With the narration off there is nothing to preview, so the test button says so instead of staying silent. */
  private syncVoiceControls(mode: VoiceMode): void {
    setDisabled(this.testVoiceButton, mode === 'off');
    this.testVoiceButton.title = mode === 'off' ? 'Ligue a narração para ouvir a voz' : '';
  }

  private applyQuality(quality: DisplayQuality): void {
    this.persistDisplay();
    this.callbacks.onQualityChange(quality);
  }

  private applyFelt(theme: FeltThemeName): void {
    this.persistDisplay();
    this.callbacks.onFeltThemeChange(theme);
  }

  private persistDisplay(): void {
    const quality: DisplayQuality = this.qualitySelector.getValue() === 'low' ? 'low' : 'high';
    const felt = FELT_OPTIONS.find((option) => option.value === this.feltSelector.getValue())?.value ?? DEFAULT_FELT_THEME;
    writeStoredJson(DISPLAY_STORAGE_KEY, { quality, felt } satisfies DisplayPreferences);
  }

  private syncFromAudio(): void {
    const settings = this.audio.getSettings();
    this.masterRow.setValue(Math.round(settings.master * 100));
    this.effectsRow.input.checked = settings.sfx;
    this.ambienceRow.input.checked = settings.ambience;
    this.voiceModeSelector.setValue(settings.voice);
    this.rateRow.setValue(settings.voiceRate);
    this.syncVoiceControls(settings.voice);
  }

  private refreshVoices(): void {
    const voices = this.audio.listVoices();
    const selectedUri = this.audio.getSettings().voiceURI ?? '';
    const key = `${selectedUri}|${voices.map((voice) => voice.voiceURI).join('|')}`;
    if (key === this.renderedVoicesKey) return;
    this.renderedVoicesKey = key;

    clearChildren(this.voiceSelect);
    this.voiceSelect.appendChild(el('option', { text: AUTOMATIC_VOICE_LABEL, attrs: { value: '' } }));
    for (const voice of voices) {
      this.voiceSelect.appendChild(el('option', { text: `${voice.name} (${voice.lang})`, attrs: { value: voice.voiceURI } }));
    }
    this.voiceSelect.value = voices.some((voice) => voice.voiceURI === selectedUri) ? selectedUri : '';
  }

  private setOpen(open: boolean): void {
    if (this.open === open) return;
    this.open = open;
    setHidden(this.popover, !open);
    this.gearButton.setAttribute('aria-expanded', String(open));
    if (open) {
      this.syncFromAudio();
      this.refreshVoices();
      document.addEventListener('pointerdown', this.handleOutsidePointer, true);
      document.addEventListener('keydown', this.handleEscape);
      this.popover.addEventListener('focusout', this.handleFocusOut);
      this.masterRow.input.focus({ preventScroll: true });
    } else {
      document.removeEventListener('pointerdown', this.handleOutsidePointer, true);
      document.removeEventListener('keydown', this.handleEscape);
      this.popover.removeEventListener('focusout', this.handleFocusOut);
      this.leaveConfirm.reset();
    }
  }
}
