import './menuKit.css';
import './loadingScreen.css';
import { clamp, el, setText } from './dom';
import { createButton } from './menuKit';

const LEAVE_TRANSITION_MS = 320;
const DEFAULT_LABEL = 'Carregando';

export class LoadingScreen {
  private readonly screen: HTMLElement;
  private readonly meter: HTMLElement;
  private readonly progress: HTMLElement;
  private readonly label: HTMLElement;
  private readonly percent: HTMLElement;
  private readonly errorBox: HTMLElement;
  private readonly errorText: HTMLElement;
  private hideTimer: number | null = null;

  constructor(root: HTMLElement) {
    root.classList.add('ui-layer', 'ui-layer--loading');

    this.progress = el(
      'div',
      {
        className: 'loading__track',
        attrs: { role: 'progressbar', 'aria-label': 'Carregando a mesa', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' },
      },
      el('div', { className: 'loading__fill' }),
    );
    this.label = el('span', { className: 'loading__label', text: 'Preparando a mesa…' });
    this.percent = el('strong', { className: 'loading__percent', text: '0%' });
    this.meter = el(
      'div',
      { className: 'loading__meter' },
      el('div', { className: 'loading__lane' }, this.progress, el('span', { className: 'loading__chip', attrs: { 'aria-hidden': 'true' } })),
      el('p', { className: 'loading__status' }, this.label, this.percent),
    );
    this.errorText = el('p', { className: 'loading__error-text' });
    this.errorBox = el('div', { className: 'loading__error', attrs: { role: 'alert', hidden: '' } }, this.errorText, this.createRetryButton());

    this.screen = el(
      'section',
      { className: 'loading', attrs: { 'aria-label': 'Carregando' } },
      el(
        'div',
        { className: 'loading__content' },
        el(
          'header',
          { className: 'loading__brand' },
          el('h1', { className: 'loading__title', text: 'Mesa Real' }),
          el('p', { className: 'loading__subtitle', text: "Texas Hold'em entre amigos, na sua rede" }),
        ),
        this.meter,
        this.errorBox,
      ),
    );
    root.appendChild(this.screen);
  }

  setProgress(ratio: number, label?: string): void {
    if (this.screen.hidden) return;
    const clamped = clamp(Number.isFinite(ratio) ? ratio : 0, 0, 1);
    const percent = Math.round(clamped * 100);
    this.meter.style.setProperty('--progress', String(clamped));
    this.progress.setAttribute('aria-valuenow', String(percent));
    setText(this.label, label ?? DEFAULT_LABEL);
    setText(this.percent, `${percent}%`);
  }

  hide(): void {
    if (this.screen.hidden || this.hideTimer !== null) return;
    this.screen.classList.add('is-leaving');
    this.hideTimer = window.setTimeout(() => {
      this.screen.hidden = true;
      this.hideTimer = null;
    }, LEAVE_TRANSITION_MS);
  }

  showError(message: string): void {
    if (this.hideTimer !== null) {
      window.clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    this.screen.hidden = false;
    this.screen.classList.remove('is-leaving');
    this.screen.classList.add('is-error');
    this.meter.hidden = true;
    setText(this.errorText, message);
    this.errorBox.hidden = false;
  }

  private createRetryButton(): HTMLButtonElement {
    const button = createButton({ label: 'Tentar novamente', tone: 'cta' });
    button.addEventListener('click', () => window.location.reload());
    return button;
  }
}
