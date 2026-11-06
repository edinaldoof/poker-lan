import type { Backlog, GameEvent, TableUpdate, TableView as TableState } from '../shared/protocol';
import type { AudioManager } from './audio/AudioManager';
import type { Stage } from './scene/Stage';
import type { TableView } from './scene/TableView';
import type { DealerBubble } from './ui/DealerBubble';
import type { Hud } from './ui/Hud';
import type { SeatPlates } from './ui/SeatPlates';

export interface GameClientDeps {
  view: TableView;
  hud: Hud;
  plates: SeatPlates;
  audio: AudioManager;
  stage: Stage;
  /** The dealer's speech bubble; absent when the dealer model is not loaded. */
  bubble?: DealerBubble;
}

const NORMAL_SPEED = 1;
const CATCH_UP_SPEED = 2.5;
// Catch-up counts the updates still waiting behind the one being shown (the contract's "queued"),
// while the skip threshold counts every queued update because that decision is taken before dequeuing.
const CATCH_UP_BACKLOG = 3;
const SKIP_ANIMATIONS_BACKLOG = 8;
const PLAY_TIMEOUT_MS = 8000;
const CLOCK_SAMPLE_COUNT = 10;

// "interrupted" is a presentation cut short on purpose (hidden tab), so unlike "failed" it is not an error.
type PlaybackOutcome = 'completed' | 'failed' | 'interrupted';

interface PlaybackWatchdog {
  verdict: Promise<'failed' | 'interrupted'>;
  stop: () => void;
}

/**
 * Ordered queue between the network and the presentation: one update is shown at a time, in `seq` order,
 * and nothing in here is allowed to stall the queue.
 */
export class GameClient {
  private readonly deps: GameClientDeps;
  private readonly queue: TableUpdate[] = [];
  private readonly clockSamples: number[] = [];
  private presentedState: TableState | null = null;
  private lastConsumedSeq: number | null = null;
  private lastSummaryHandNumber = 0;
  private draining = false;
  // Bumped on resetSequence() so a presentation that was in flight when it happened discards its result.
  private generation = 0;
  private inGame = false;

  constructor(deps: GameClientDeps) {
    this.deps = deps;
  }

  /** Median of the last samples of `serverTime - Date.now()`; add it to Date.now() to get the server clock. */
  get serverOffsetMs(): number {
    if (this.clockSamples.length === 0) {
      return 0;
    }
    const sorted = [...this.clockSamples].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
  }

  /** Narration is spoken and the camera is recovered only while the player is sitting at the table. */
  setInGame(inGame: boolean): void {
    this.inGame = inGame;
    if (!inGame) this.safely('bubble.clear', () => this.deps.bubble?.clear());
  }

  enqueue(update: TableUpdate): void {
    this.recordClockSample(update.serverTime);
    if (!this.accepts(update)) {
      return;
    }
    this.insertInOrder(update);
    void this.drain();
  }

  setBacklog(backlog: Backlog): void {
    this.lastSummaryHandNumber = backlog.hands.reduce((highest, hand) => Math.max(highest, hand.handNumber), 0);
    this.safely('hud.setBacklog', () => this.deps.hud.setBacklog(backlog));
  }

  /**
   * Forgets the sequence after a reconnect: the server may have restarted (its seq starts over) or
   * the stream may have skipped updates, so the next update becomes a fresh baseline.
   */
  resetSequence(): void {
    this.generation += 1;
    this.queue.length = 0;
    this.lastConsumedSeq = null;
    this.presentedState = null;
    this.lastSummaryHandNumber = 0;
  }

  private recordClockSample(serverTime: number): void {
    if (!Number.isFinite(serverTime)) {
      return;
    }
    this.clockSamples.push(serverTime - Date.now());
    if (this.clockSamples.length > CLOCK_SAMPLE_COUNT) {
      this.clockSamples.shift();
    }
  }

  private accepts(update: TableUpdate): boolean {
    if (this.lastConsumedSeq !== null && update.seq <= this.lastConsumedSeq) {
      return false;
    }
    return !this.queue.some((queued) => queued.seq === update.seq);
  }

  private insertInOrder(update: TableUpdate): void {
    const index = this.queue.findIndex((queued) => queued.seq > update.seq);
    if (index === -1) {
      this.queue.push(update);
    } else {
      this.queue.splice(index, 0, update);
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        try {
          await this.presentNext();
        } catch (error) {
          console.error('[GameClient] failed to present an update', error);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async presentNext(): Promise<void> {
    const generation = this.generation;
    if (this.mustSkipAnimations()) {
      this.resyncToLatest();
      return;
    }
    const update = this.queue.shift();
    if (update === undefined) {
      return;
    }
    this.lastConsumedSeq = update.seq;
    const speed = this.queue.length >= CATCH_UP_BACKLOG ? CATCH_UP_SPEED : NORMAL_SPEED;
    await this.present(update, speed, generation);
  }

  // A hidden tab pauses GSAP, so animating there would only pile up the queue.
  private mustSkipAnimations(): boolean {
    if (this.isPageHidden() || this.queue.length >= SKIP_ANIMATIONS_BACKLOG) {
      return true;
    }
    return this.lastConsumedSeq !== null && this.queue[0].seq !== this.lastConsumedSeq + 1;
  }

  private isPageHidden(): boolean {
    return typeof document !== 'undefined' && document.hidden;
  }

  private async present(update: TableUpdate, speed: number, generation: number): Promise<void> {
    const previous = this.presentedState;
    const next = update.state;
    this.announce(update, true);

    // Slots rotate with the viewer's seat, so an animation between two rotations would be wrong.
    if (previous === null || previous.self.seat !== next.self.seat) {
      this.syncView(next);
      this.showState(next);
    } else if (update.event.kind === 'turn') {
      this.showState(next);
      void this.playSafely(update.event, previous, next, speed);
    } else {
      const outcome = await this.playSafely(update.event, previous, next, speed);
      if (generation !== this.generation) {
        return;
      }
      this.settleAfterPlayback(outcome, next);
      this.showState(next);
    }
    this.recordHandSummary(update.event);
  }

  private resyncToLatest(): void {
    const skipped = this.queue.splice(0);
    const latest = skipped[skipped.length - 1];
    this.lastConsumedSeq = latest.seq;
    for (const update of skipped) {
      this.announce(update, update === latest);
      this.recordHandSummary(update.event);
    }
    this.syncView(latest.state);
    this.showState(latest.state);
  }

  private announce(update: TableUpdate, speak: boolean): void {
    const narration = update.narration;
    if (narration === null) {
      return;
    }
    // The log lists backlog entries with the server's clock, so live lines must carry the same one.
    this.safely('hud.announce', () => this.deps.hud.announce(narration, update.serverTime));
    // While catching up, only the last line is spoken and shown by the dealer; the rest only reach the log.
    if (speak && this.inGame) {
      this.safely('audio.speak', () => this.deps.audio.speak(narration.speech ?? narration.text, narration.priority));
      this.safely('bubble.say', () => this.deps.bubble?.say(narration));
    }
  }

  private async playSafely(
    event: GameEvent,
    previous: TableState,
    next: TableState,
    speed: number,
  ): Promise<PlaybackOutcome> {
    const watchdog = this.startPlaybackWatchdog();
    try {
      const finished = this.deps.view.play(event, previous, next, speed).then((): PlaybackOutcome => 'completed');
      const outcome = await Promise.race([finished, watchdog.verdict]);
      if (outcome === 'failed') {
        console.error(`[GameClient] animation "${event.kind}" took longer than ${PLAY_TIMEOUT_MS} ms; resyncing`);
      }
      return outcome;
    } catch (error) {
      console.error(`[GameClient] animation "${event.kind}" failed; resyncing`, error);
      return 'failed';
    } finally {
      watchdog.stop();
    }
  }

  // Hiding the tab stops requestAnimationFrame, so the animation in flight would never resolve on its own and
  // everything queued behind it (the player's turn alert included) would wait for the full timeout.
  private startPlaybackWatchdog(): PlaybackWatchdog {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onVisibilityChange: (() => void) | undefined;
    const verdict = new Promise<'failed' | 'interrupted'>((resolve) => {
      timer = setTimeout(() => resolve('failed'), PLAY_TIMEOUT_MS);
      if (typeof document === 'undefined') {
        return;
      }
      onVisibilityChange = () => {
        if (this.isPageHidden()) {
          resolve('interrupted');
        }
      };
      document.addEventListener('visibilitychange', onVisibilityChange);
    });
    return {
      verdict,
      stop: () => {
        clearTimeout(timer);
        if (onVisibilityChange !== undefined) {
          document.removeEventListener('visibilitychange', onVisibilityChange);
        }
      },
    };
  }

  private settleAfterPlayback(outcome: PlaybackOutcome, state: TableState): void {
    if (outcome === 'failed') {
      this.recoverFromFailedAnimation(state);
    } else if (outcome === 'interrupted') {
      this.syncView(state);
    }
  }

  private recoverFromFailedAnimation(state: TableState): void {
    this.syncView(state);
    if (this.inGame) {
      this.safely('stage.resetCamera', () => this.deps.stage.resetCamera());
    }
  }

  private syncView(state: TableState): void {
    this.safely('view.sync', () => this.deps.view.sync(state, state.self.seat));
  }

  private showState(state: TableState): void {
    this.presentedState = state;
    const offset = this.serverOffsetMs;
    this.safely('hud.render', () => this.deps.hud.render(state, offset));
    this.safely('plates.update', () => this.deps.plates.update(state, offset));
  }

  // The backlog sent on join can already contain a hand whose handEnd update is still waiting in the queue.
  private recordHandSummary(event: GameEvent): void {
    if (event.kind !== 'handEnd' || event.summary.handNumber <= this.lastSummaryHandNumber) {
      return;
    }
    this.lastSummaryHandNumber = event.summary.handNumber;
    this.safely('hud.addHandSummary', () => this.deps.hud.addHandSummary(event.summary));
  }

  private safely(label: string, action: () => void): void {
    try {
      action();
    } catch (error) {
      console.error(`[GameClient] ${label} failed`, error);
    }
  }
}
