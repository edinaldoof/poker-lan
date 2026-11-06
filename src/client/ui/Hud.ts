import './hud.css';
import type { Backlog, HandSummary, Narration, PlayerActionRequest, TableConfig, TableView } from '../../shared/protocol';
import type { AudioManager } from '../audio/AudioManager';
import type { ManualPanel } from '../manual/ManualPanel';
import { ActionBar } from './ActionBar';
import { createIcon, el, setData, setHidden, setText } from './dom';
import { HostPanel } from './HostPanel';
import { JudgePanel } from './JudgePanel';
import { LogPanel } from './LogPanel';
import { SettingsPanel } from './SettingsPanel';

export interface HudCallbacks {
  onAction(request: PlayerActionRequest): void;
  onAddBot(): void;
  onRemoveBot(): void;
  onStart(config: Partial<TableConfig>): void;
  onRebuy(): void;
  onLeave(): void;
  onQualityChange(quality: 'high' | 'low'): void;
  onFeltThemeChange(theme: 'emerald' | 'royal' | 'burgundy'): void;
  onToggleZoom(): void;
}

const MAX_TOASTS = 3;
const TOAST_MS = { info: 3200, error: 5200 };
const TOAST_LEAVE_MS = 260;
const MIN_PLAYERS_TO_DEAL = 2;

class ToastStack {
  readonly element = el('div', { className: 'toast-stack' });

  show(text: string, tone: 'info' | 'error'): void {
    const toast = el('div', { className: 'toast', text, dataset: { tone }, attrs: { role: tone === 'error' ? 'alert' : 'status' } });
    this.element.appendChild(toast);
    while (this.element.childElementCount > MAX_TOASTS) this.element.firstElementChild?.remove();
    window.setTimeout(() => this.dismiss(toast), TOAST_MS[tone]);
  }

  private dismiss(toast: HTMLElement): void {
    toast.classList.add('is-leaving');
    window.setTimeout(() => toast.remove(), TOAST_LEAVE_MS);
  }
}

/** Composes every HUD component; render() only forwards state, each component diffs its own DOM. */
export class Hud {
  private readonly container: HTMLElement;
  private readonly judge = new JudgePanel();
  private readonly log = new LogPanel();
  private readonly toasts = new ToastStack();
  private readonly hostPanel: HostPanel;
  private readonly settingsPanel: SettingsPanel;
  private readonly actionBar: ActionBar;
  private readonly spectatorBanner: HTMLElement;
  private readonly bustedBanner: HTMLElement;
  private readonly waitingBanner: HTMLElement;
  private readonly handChip: HTMLButtonElement;
  private readonly handChipValue: HTMLElement;
  private highlightedHand: string | null = null;

  constructor(
    root: HTMLElement,
    callbacks: HudCallbacks,
    private readonly audio: AudioManager,
    private readonly manual?: ManualPanel,
  ) {
    root.classList.add('ui-layer', 'ui-layer--hud');

    this.hostPanel = new HostPanel({
      onAddBot: () => callbacks.onAddBot(),
      onRemoveBot: () => callbacks.onRemoveBot(),
      onStart: (config) => callbacks.onStart(config),
    });
    this.settingsPanel = new SettingsPanel(
      {
        onQualityChange: (quality) => callbacks.onQualityChange(quality),
        onFeltThemeChange: (theme) => callbacks.onFeltThemeChange(theme),
        onLeave: () => callbacks.onLeave(),
      },
      this.audio,
    );
    this.actionBar = new ActionBar((request) => callbacks.onAction(request), this.audio);

    this.spectatorBanner = el('div', { className: 'banner', text: 'Você está assistindo', attrs: { hidden: '' } });
    this.waitingBanner = el('div', { className: 'banner', text: 'Aguardando mais jogadores…', attrs: { hidden: '' } });
    const rebuyButton = el('button', { className: 'hud-cta', text: 'Recomprar fichas', attrs: { type: 'button' } });
    rebuyButton.addEventListener('click', () => callbacks.onRebuy());
    this.bustedBanner = el('div', { className: 'banner banner--action', attrs: { hidden: '' } }, el('span', { text: 'Você ficou sem fichas' }), rebuyButton);

    this.handChipValue = el('strong', { className: 'hand-chip__value' });
    this.handChip = this.createHandChip();

    this.container = el(
      'div',
      { className: 'hud', attrs: { hidden: '' } },
      // One column at the top-left (toolbar, the Judge, toasts) keeps the dealer at the top centre in view;
      // on short landscape screens CSS turns it into a single strip.
      el(
        'div',
        { className: 'hud-top' },
        el('div', { className: 'hud-toolbar' }, this.settingsPanel.element, this.createZoomButton(callbacks), this.createManualButton(), this.hostPanel.compactElement),
        this.judge.element,
        this.toasts.element,
      ),
      this.log.element,
      el(
        'div',
        { className: 'hud-bottom' },
        el('div', { className: 'hud-banners' }, this.spectatorBanner, this.bustedBanner, this.waitingBanner),
        this.hostPanel.lobbyElement,
        this.handChip,
        this.actionBar.element,
      ),
    );
    this.container.addEventListener('click', (event) => this.playClickSound(event));
    root.appendChild(this.container);
  }

  show(): void {
    this.container.hidden = false;
  }

  hide(): void {
    this.container.hidden = true;
  }

  render(state: TableView, serverOffsetMs: number): void {
    setData(this.container, 'phase', state.phase);
    this.judge.update(state);
    this.hostPanel.update(state);
    this.actionBar.update(state, serverOffsetMs);
    this.renderBanners(state);
    this.renderHandStrength(state);
  }

  /** serverTime stamps the log line with the table's clock, like the backlog lines, whatever this device's clock says. */
  announce(narration: Narration, serverTime?: number): void {
    this.judge.announce(narration);
    this.log.announce(narration, serverTime);
  }

  setBacklog(backlog: Backlog): void {
    this.log.setBacklog(backlog);
  }

  addHandSummary(summary: HandSummary): void {
    this.log.addHandSummary(summary);
  }

  toast(text: string, tone: 'info' | 'error' = 'info'): void {
    this.toasts.show(text, tone);
  }

  /** The table refused something the player just sent; only this kind of error frees the action bar again. */
  reportTableError(message: string): void {
    this.toasts.show(message, 'error');
    this.actionBar.handleActionError();
  }

  private createZoomButton(callbacks: HudCallbacks): HTMLButtonElement {
    const button = el(
      'button',
      {
        className: 'hud-tool',
        attrs: {
          type: 'button',
          title: 'Aproximar das suas cartas ou voltar à visão geral (também pela roda do mouse, pinça ou duplo clique)',
          'aria-label': 'Alternar zoom da mesa',
        },
      },
      el('span', { className: 'hud-tool__icon', text: '🔍', attrs: { 'aria-hidden': 'true' } }),
      el('span', { className: 'hud-tool__label', text: 'Zoom' }),
    );
    button.addEventListener('click', () => callbacks.onToggleZoom());
    return button;
  }

  private createManualButton(): HTMLButtonElement | null {
    if (this.manual === undefined) return null;
    const button = this.manual.createOpenButton();
    button.setAttribute('data-qa', 'manual-open');
    // The label is hidden on narrow screens, so the button needs a name of its own.
    button.setAttribute('aria-label', 'Manual do jogo');
    return button;
  }

  private createHandChip(): HTMLButtonElement {
    const chip = el(
      'button',
      { className: 'hand-chip', attrs: { type: 'button', hidden: '', title: 'Ver o ranking das mãos no manual' } },
      el('span', { className: 'hand-chip__label', text: 'Você tem' }),
      this.handChipValue,
      el('span', { className: 'hand-chip__arrow' }, createIcon('chevron', 16)),
    );
    chip.addEventListener('click', () => this.manual?.open('ranking'));
    return chip;
  }

  private renderBanners(state: TableView): void {
    const seat = state.self.seat === null ? null : (state.seats[state.self.seat] ?? null);
    const isRunning = state.phase === 'running';
    const canPlay = state.seats.filter((other) => other !== null && other.chips > 0 && other.status !== 'sittingOut' && other.status !== 'busted').length;

    setHidden(this.spectatorBanner, !state.self.isSpectator);
    setHidden(this.bustedBanner, state.self.isSpectator || seat === null || seat.status !== 'busted');
    setHidden(this.waitingBanner, !(isRunning && state.street === 'idle' && canPlay < MIN_PLAYERS_TO_DEAL));
  }

  private renderHandStrength(state: TableView): void {
    const seat = state.self.seat === null ? null : (state.seats[state.self.seat] ?? null);
    const inHand = seat !== null && (seat.status === 'active' || seat.status === 'allIn') && seat.cardCount > 0;
    const handName = state.phase === 'running' && inHand && state.self.handName ? state.self.handName : null;
    setHidden(this.handChip, handName === null);
    if (handName !== null) {
      setText(this.handChipValue, handName);
      this.handChip.setAttribute('aria-label', `Você tem ${handName}. Ver o ranking das mãos no manual`);
    }
    this.actionBar.setHandName(handName);
    this.highlightInManual(handName);
  }

  private highlightInManual(handName: string | null): void {
    if (handName === this.highlightedHand) return;
    this.highlightedHand = handName;
    this.manual?.highlightHand(handName);
  }

  /** One delegated listener gives every HUD button its click; the action bar plays its own. */
  private playClickSound(event: MouseEvent): void {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest('button');
    if (button === null || button.disabled || button.closest('.action-bar') !== null) return;
    this.audio.play('uiClick');
  }
}
