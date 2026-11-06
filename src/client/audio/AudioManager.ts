import { type Card, rankName, rankValue, suitName, type SuitChar } from '../../shared/cards';
import {
  createNoiseBuffers,
  createRoomAmbience,
  createRoomImpulse,
  playSynthSound,
  type Ambience,
  type SoundName,
  type SynthEnvironment,
} from './synth';

export type { SoundName } from './synth';

export type VoiceMode = 'full' | 'essential' | 'off';

export interface AudioSettings {
  /** 0..1 */
  master: number;
  sfx: boolean;
  ambience: boolean;
  voice: VoiceMode;
  /** speechSynthesis rate, 0.5..2 */
  voiceRate: number;
  voiceURI: string | null;
}

export interface PlaySoundOptions {
  /** 0..2, defaults to 1. */
  volume?: number;
  /** -1 (left) .. 1 (right), defaults to 0. */
  pan?: number;
  /** Seconds from now (the unit of the Web Audio clock and of GSAP timelines), capped at 10. */
  delay?: number;
  /**
   * chipClink: number of clinks; chipStack: chips dropped; chipsSlide: clinks inside the slide;
   * potCollect: clinks in the cascade; shuffle: riffle passes. Ignored by the other sounds.
   */
  count?: number;
}

export const DEFAULT_AUDIO_SETTINGS: Readonly<AudioSettings> = {
  master: 0.8,
  sfx: true,
  ambience: false,
  voice: 'essential',
  voiceRate: 1.05,
  voiceURI: null,
};

const STORAGE_KEY = 'poker-lan.audio';
const MIN_VOICE_RATE = 0.5;
const MAX_VOICE_RATE = 2;
const MAX_DELAY_SECONDS = 10;
const PARAM_SMOOTHING_SECONDS = 0.02;
const RESUME_RETRY_MS = 1000;
const RESUME_TIMEOUT_MS = 1500;
const REVERB_SECONDS = 0.6;
const REVERB_RETURN_LEVEL = 0.7;

const SPEECH_LANGUAGE = 'pt-BR';
const MAX_SPEECH_QUEUE = 3;
const MAX_SPEECH_LENGTH = 280;
/** A narration that waited this long describes something the table has already moved past. */
const STALE_SPEECH_MS = 8000;
/** Generous estimate of speaking time (~9 characters/second at rate 1) before assuming the engine is stuck. */
const WATCHDOG_BASE_MS = 1500;
const WATCHDOG_MS_PER_CHARACTER = 110;
const MIN_WATCHDOG_MS = 3000;

/** Events that browsers accept as a user activation for starting audio. */
const GESTURE_EVENTS = ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'] as const;

// -- settings ----------------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value, min, max) : fallback;
}

function isVoiceMode(value: unknown): value is VoiceMode {
  return value === 'full' || value === 'essential' || value === 'off';
}

/** Applies only the valid fields of an untrusted patch (storage content or caller input) on top of `base`. */
function mergeSettings(base: AudioSettings, patch: unknown): AudioSettings {
  if (typeof patch !== 'object' || patch === null) return { ...base };
  const input = patch as Record<string, unknown>;
  let voiceURI = base.voiceURI;
  if (input.voiceURI === null || input.voiceURI === '') voiceURI = null;
  else if (typeof input.voiceURI === 'string') voiceURI = input.voiceURI;

  return {
    master: readNumber(input.master, 0, 1, base.master),
    sfx: typeof input.sfx === 'boolean' ? input.sfx : base.sfx,
    ambience: typeof input.ambience === 'boolean' ? input.ambience : base.ambience,
    voice: isVoiceMode(input.voice) ? input.voice : base.voice,
    voiceRate: readNumber(input.voiceRate, MIN_VOICE_RATE, MAX_VOICE_RATE, base.voiceRate),
    voiceURI,
  };
}

function getStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function loadSettings(): AudioSettings {
  try {
    const stored = getStorage()?.getItem(STORAGE_KEY);
    if (stored) return mergeSettings(DEFAULT_AUDIO_SETTINGS, JSON.parse(stored));
  } catch {
    // Corrupt JSON or blocked storage: fall back to the defaults.
  }
  return { ...DEFAULT_AUDIO_SETTINGS };
}

function persistSettings(settings: AudioSettings): void {
  try {
    getStorage()?.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Private mode or quota: the settings still apply for this session.
  }
}

/** Slider position to amplitude: squaring matches how loudness is perceived. */
function masterGainFor(master: number): number {
  return master * master;
}

function toDelaySeconds(delay: number | undefined): number {
  if (delay === undefined || !Number.isFinite(delay)) return 0;
  return clamp(delay, 0, MAX_DELAY_SECONDS);
}

// -- audio graph -------------------------------------------------------------------------------

interface AudioGraph {
  context: AudioContext;
  master: GainNode;
  sfxBus: GainNode;
  ambienceBus: GainNode;
  env: SynthEnvironment;
}

interface WebkitAudioWindow {
  webkitAudioContext?: typeof AudioContext;
}

function resolveAudioContextConstructor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  return window.AudioContext ?? (window as unknown as WebkitAudioWindow).webkitAudioContext ?? null;
}

/**
 * sfx voices -> sfxBus (+ reverb send -> convolver -> reverb return -> sfxBus) -> master -> compressor
 * -> destination; the ambience bus joins at the master.
 */
function buildGraph(context: AudioContext): AudioGraph {
  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = -16;
  compressor.knee.value = 18;
  compressor.ratio.value = 4;
  compressor.attack.value = 0.004;
  compressor.release.value = 0.18;
  compressor.connect(context.destination);

  const master = context.createGain();
  master.connect(compressor);

  const sfxBus = context.createGain();
  sfxBus.connect(master);

  const reverbSend = context.createGain();
  const convolver = context.createConvolver();
  convolver.buffer = createRoomImpulse(context, REVERB_SECONDS);
  const reverbReturn = context.createGain();
  reverbReturn.gain.value = REVERB_RETURN_LEVEL;
  reverbSend.connect(convolver);
  convolver.connect(reverbReturn);
  reverbReturn.connect(sfxBus);

  const ambienceBus = context.createGain();
  ambienceBus.connect(master);

  return {
    context,
    master,
    sfxBus,
    ambienceBus,
    env: { context, output: sfxBus, reverbSend, noise: createNoiseBuffers(context) },
  };
}

/** `resume()` can stay pending forever without a user gesture; callers must not wait on it. */
function resumeWithTimeout(context: AudioContext): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, RESUME_TIMEOUT_MS);
    const settle = () => {
      clearTimeout(timer);
      resolve();
    };
    Promise.resolve(context.resume()).then(settle, settle);
  });
}

// -- speech ------------------------------------------------------------------------------------

interface QueuedSpeech {
  text: string;
  priority: 1 | 2;
  queuedAt: number;
}

const SUIT_BY_SYMBOL: Record<string, SuitChar> = { '♣': 'c', '♦': 'd', '♥': 'h', '♠': 's' };
const CARD_LABEL_PATTERN = /\b(10|[2-9AKQJ])\s?([♣♦♥♠])/g;

function spokenCard(rank: string, symbol: string): string {
  const rankChar = rank === '10' ? 'T' : rank;
  const value = rankValue(`${rankChar}c` as Card);
  return `${rankName(value).singular} de ${suitName(SUIT_BY_SYMBOL[symbol])}`;
}

/**
 * Narrations normally carry a spoken variant; this keeps plain log lines pronounceable too
 * (voices read "A♠" or "·" unpredictably).
 */
function normalizeForSpeech(text: string): string {
  return text
    .replace(CARD_LABEL_PATTERN, (_match, rank: string, symbol: string) => spokenCard(rank, symbol))
    .replace(/[♣♦♥♠]/g, '')
    .replace(/#(\d+)/g, 'número $1')
    .replace(/\s*[·—–]\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SPEECH_LENGTH);
}

function findSpeechSynthesis(): SpeechSynthesis | null {
  try {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;
    if (typeof SpeechSynthesisUtterance === 'undefined') return null;
    return window.speechSynthesis ?? null;
  } catch {
    return null;
  }
}

/** 0 = Brazilian Portuguese, 1 = other Portuguese, 2 = anything else. Android reports "pt_BR". */
function languageRank(voice: SpeechSynthesisVoice): number {
  const language = voice.lang.replace('_', '-').toLowerCase();
  if (language === 'pt-br') return 0;
  return language.startsWith('pt') ? 1 : 2;
}

/** Neural/online voices sound far more natural than the legacy local ones, so they go first. */
function qualityScore(voice: SpeechSynthesisVoice): number {
  let score = 0;
  if (/natural|neural|premium|enhanced|online/i.test(voice.name)) score += 3;
  if (/google/i.test(voice.name)) score += 1;
  if (voice.localService) score += 0.5;
  return score;
}

function compareVoices(a: SpeechSynthesisVoice, b: SpeechSynthesisVoice): number {
  return languageRank(a) - languageRank(b) || qualityScore(b) - qualityScore(a) || a.name.localeCompare(b.name);
}

/**
 * Owns its own queue instead of the browser's: the browser queue cannot drop stale items, and
 * cancel() is unreliable across engines. Does nothing at all when speechSynthesis is missing.
 */
class SpeechNarrator {
  private readonly synthesis: SpeechSynthesis | null = findSpeechSynthesis();
  private readonly readSettings: () => AudioSettings;
  private voices: SpeechSynthesisVoice[] = [];
  private queue: QueuedSpeech[] = [];
  private activeUtterance: SpeechSynthesisUtterance | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private isPrimed = false;

  constructor(readSettings: () => AudioSettings) {
    this.readSettings = readSettings;
    this.watchVoiceList();
  }

  listVoices(): SpeechSynthesisVoice[] {
    if (this.voices.length === 0) this.refreshVoices();
    return [...this.voices];
  }

  enqueue(text: string, priority: 1 | 2): void {
    const settings = this.readSettings();
    if (!this.synthesis || settings.voice === 'off' || settings.master <= 0) return;
    if (priority !== 1 && settings.voice === 'essential') return;
    const spokenText = normalizeForSpeech(text);
    if (!spokenText) return;

    const level = priority === 1 ? 1 : 2;
    // Detail lines are worthless once something important is announced.
    if (level === 1) this.queue = this.queue.filter((item) => item.priority === 1);
    this.queue.push({ text: spokenText, priority: level, queuedAt: Date.now() });
    this.trimQueue();
    this.pump();
  }

  /**
   * iOS only lets speech start from a user gesture; speaking one silent utterance there unlocks
   * every later utterance.
   */
  prime(): void {
    if (!this.synthesis || this.isPrimed) return;
    this.isPrimed = true;
    try {
      const silent = new SpeechSynthesisUtterance(' ');
      silent.volume = 0;
      this.synthesis.speak(silent);
    } catch {
      // Speech just stays unavailable.
    }
  }

  handleSettingsChange(previous: AudioSettings, next: AudioSettings): void {
    if (next.voice === 'off' || next.master <= 0) {
      this.cancelAll();
      return;
    }
    if (next.voice === 'essential') this.queue = this.queue.filter((item) => item.priority === 1);
    if (previous.voice === 'off') this.prime();
  }

  private watchVoiceList(): void {
    if (!this.synthesis) return;
    this.refreshVoices();
    const refresh = () => this.refreshVoices();
    try {
      if (typeof this.synthesis.addEventListener === 'function') {
        this.synthesis.addEventListener('voiceschanged', refresh);
      } else {
        this.synthesis.onvoiceschanged = refresh;
      }
    } catch {
      // The list is also refreshed lazily whenever it is empty.
    }
  }

  private refreshVoices(): void {
    try {
      this.voices = [...(this.synthesis?.getVoices() ?? [])].sort(compareVoices);
    } catch {
      this.voices = [];
    }
  }

  private pickVoice(voiceURI: string | null): SpeechSynthesisVoice | null {
    if (this.voices.length === 0) this.refreshVoices();
    const chosen = voiceURI ? this.voices.find((voice) => voice.voiceURI === voiceURI) : undefined;
    return chosen ?? this.voices.find((voice) => languageRank(voice) < 2) ?? null;
  }

  /** Keeps at most MAX_SPEECH_QUEUE items, sacrificing detail lines first and then the oldest. */
  private trimQueue(): void {
    while (this.queue.length > MAX_SPEECH_QUEUE) {
      const oldestDetail = this.queue.findIndex((item) => item.priority === 2);
      this.queue.splice(oldestDetail >= 0 ? oldestDetail : 0, 1);
    }
  }

  private takeNextFresh(): QueuedSpeech | null {
    const now = Date.now();
    for (let next = this.queue.shift(); next; next = this.queue.shift()) {
      if (now - next.queuedAt <= STALE_SPEECH_MS) return next;
    }
    return null;
  }

  private pump(): void {
    if (!this.synthesis || this.activeUtterance) return;
    const next = this.takeNextFresh();
    if (!next) return;

    const settings = this.readSettings();
    const utterance = new SpeechSynthesisUtterance(next.text);
    utterance.lang = SPEECH_LANGUAGE;
    utterance.rate = settings.voiceRate;
    utterance.volume = clamp(settings.master, 0, 1);
    const voice = this.pickVoice(settings.voiceURI);
    // The voice alone picks the accent: its own `lang` may be "pt_BR" (Android, not a valid BCP 47 tag)
    // or pt-PT, so utterance.lang stays pt-BR.
    if (voice) utterance.voice = voice;
    const finish = () => this.finishUtterance(utterance);
    utterance.onend = finish;
    utterance.onerror = finish;

    // Held in a field on purpose: Chrome drops 'end' events of garbage-collected utterances.
    this.activeUtterance = utterance;
    this.armWatchdog(utterance, next.text, settings.voiceRate);
    try {
      this.synthesis.speak(utterance);
    } catch {
      this.finishUtterance(utterance);
    }
  }

  private finishUtterance(utterance: SpeechSynthesisUtterance): void {
    if (this.activeUtterance !== utterance) return;
    this.clearWatchdog();
    this.activeUtterance = null;
    this.pump();
  }

  /** Some engines never report the end of an utterance (backgrounded tab, stuck pause). */
  private armWatchdog(utterance: SpeechSynthesisUtterance, text: string, rate: number): void {
    this.clearWatchdog();
    // No upper cap: text length (MAX_SPEECH_LENGTH) and rate (MIN_VOICE_RATE) already bound it, and a
    // fixed cap would cut the longest narrations at the slowest rate in the middle of a sentence.
    const safeRate = clamp(rate, MIN_VOICE_RATE, MAX_VOICE_RATE);
    const timeoutMs = Math.max(
      MIN_WATCHDOG_MS,
      WATCHDOG_BASE_MS + (text.length * WATCHDOG_MS_PER_CHARACTER) / safeRate,
    );
    this.watchdogTimer = setTimeout(() => {
      try {
        this.synthesis?.cancel();
      } catch {
        // Nothing else to do: the queue moves on regardless.
      }
      this.finishUtterance(utterance);
    }, timeoutMs);
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer !== null) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  private cancelAll(): void {
    this.queue = [];
    this.clearWatchdog();
    if (!this.activeUtterance) return;
    this.activeUtterance = null;
    try {
      this.synthesis?.cancel();
    } catch {
      // Already silent as far as the game is concerned.
    }
  }
}

// -- manager -----------------------------------------------------------------------------------

/**
 * Web Audio casino sounds plus pt-BR narration. Every public method is safe to call at any time:
 * before the context is unlocked, without Web Audio, or without speechSynthesis.
 */
export class AudioManager {
  private settings: AudioSettings;
  private graph: AudioGraph | null = null;
  private ambience: Ambience | null = null;
  private isUnsupported = false;
  private lastResumeAttempt = 0;
  private hasReportedFailure = false;
  private readonly narrator: SpeechNarrator;

  constructor() {
    this.settings = loadSettings();
    this.narrator = new SpeechNarrator(() => this.settings);
    this.listenForUserGesture();
  }

  /** Creates/resumes the AudioContext. Call from a user gesture; repeated calls are harmless. */
  async unlock(): Promise<void> {
    try {
      const graph = this.ensureGraph();
      if (!graph) return;
      // Before any await: iOS accepts speech only inside the gesture's synchronous part.
      if (this.settings.voice !== 'off') this.narrator.prime();
      if (graph.context.state !== 'running') await resumeWithTimeout(graph.context);
      this.applyAmbience();
    } catch (error) {
      this.reportFailure(error);
    }
  }

  play(name: SoundName, options: PlaySoundOptions = {}): void {
    try {
      if (!this.settings.sfx) return;
      const graph = this.getRunningGraph();
      if (!graph) return;
      playSynthSound(graph.env, name, {
        when: graph.context.currentTime + toDelaySeconds(options.delay) + 0.005,
        volume: options.volume ?? 1,
        pan: options.pan ?? 0,
        count: options.count,
      });
    } catch (error) {
      this.reportFailure(error);
    }
  }

  speak(text: string, priority: 1 | 2): void {
    try {
      this.narrator.enqueue(text, priority);
    } catch (error) {
      this.reportFailure(error);
    }
  }

  getSettings(): AudioSettings {
    return { ...this.settings };
  }

  setSettings(partial: Partial<AudioSettings>): void {
    try {
      const previous = this.settings;
      this.settings = mergeSettings(previous, partial);
      persistSettings(this.settings);
      this.applyMixSettings();
      this.narrator.handleSettingsChange(previous, this.settings);
    } catch (error) {
      this.reportFailure(error);
    }
  }

  /** Portuguese voices first (pt-BR before other pt), then the rest; empty without speechSynthesis. */
  listVoices(): SpeechSynthesisVoice[] {
    try {
      return this.narrator.listVoices();
    } catch {
      return [];
    }
  }

  private listenForUserGesture(): void {
    if (typeof document === 'undefined') return;
    const unlockOnGesture = () => {
      if (this.graph?.context.state === 'running') return;
      void this.unlock();
    };
    // Kept for the page's lifetime: iOS and tab switches can suspend the context again.
    for (const type of GESTURE_EVENTS) {
      document.addEventListener(type, unlockOnGesture, { capture: true, passive: true });
    }
  }

  private ensureGraph(): AudioGraph | null {
    if (this.graph) return this.graph;
    if (this.isUnsupported) return null;
    try {
      const AudioContextConstructor = resolveAudioContextConstructor();
      if (!AudioContextConstructor) {
        this.isUnsupported = true;
        return null;
      }
      this.graph = buildGraph(new AudioContextConstructor());
      this.applyMixSettings(true);
      return this.graph;
    } catch (error) {
      this.isUnsupported = true;
      this.graph = null;
      this.reportFailure(error);
      return null;
    }
  }

  private getRunningGraph(): AudioGraph | null {
    const graph = this.graph;
    if (!graph) return null;
    if (graph.context.state === 'running') return graph;
    this.tryResume(graph.context);
    return null;
  }

  /** Throttled: a rejected resume() logs a console warning every time. */
  private tryResume(context: AudioContext): void {
    const now = Date.now();
    if (now - this.lastResumeAttempt < RESUME_RETRY_MS) return;
    this.lastResumeAttempt = now;
    try {
      Promise.resolve(context.resume()).catch(() => undefined);
    } catch {
      // Needs a user gesture; the gesture listener will retry.
    }
  }

  private applyMixSettings(immediate = false): void {
    const graph = this.graph;
    if (!graph) return;
    const masterGain = masterGainFor(this.settings.master);
    const sfxGain = this.settings.sfx ? 1 : 0;
    if (immediate) {
      graph.master.gain.value = masterGain;
      graph.sfxBus.gain.value = sfxGain;
    } else {
      const now = graph.context.currentTime;
      graph.master.gain.setTargetAtTime(masterGain, now, PARAM_SMOOTHING_SECONDS);
      graph.sfxBus.gain.setTargetAtTime(sfxGain, now, PARAM_SMOOTHING_SECONDS);
    }
    this.applyAmbience();
  }

  private applyAmbience(): void {
    const graph = this.graph;
    if (!graph) return;
    if (this.settings.ambience) {
      this.ambience ??= createRoomAmbience(graph.context, graph.ambienceBus);
    } else if (this.ambience) {
      this.ambience.stop();
      this.ambience = null;
    }
  }

  /** Audio is decoration: report the first failure for debugging, then stay quiet. */
  private reportFailure(error: unknown): void {
    if (this.hasReportedFailure) return;
    this.hasReportedFailure = true;
    console.warn('[audio] audio failure, continuing without it:', error);
  }
}
