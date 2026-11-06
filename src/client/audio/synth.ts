/**
 * Procedural casino sound synthesis (no audio files). Everything here only schedules Web Audio nodes
 * on a context handed in by AudioManager; there is no global state besides small caches.
 */

export type SoundName =
  | 'cardSlide'
  | 'cardSnap'
  | 'cardFlip'
  | 'shuffle'
  | 'chipClink'
  | 'chipStack'
  | 'chipsSlide'
  | 'knock'
  | 'fold'
  | 'tick'
  | 'tickUrgent'
  | 'yourTurn'
  | 'allIn'
  | 'win'
  | 'potCollect'
  | 'uiClick';

export type NoiseKind = 'white' | 'pink' | 'brown';
export type NoiseBuffers = Record<NoiseKind, AudioBuffer>;

export interface SynthEnvironment {
  context: BaseAudioContext;
  /** Dry SFX bus input. */
  output: AudioNode;
  /** Input of the shared room reverb. */
  reverbSend: AudioNode;
  noise: NoiseBuffers;
}

export interface SynthPlayOptions {
  /** Absolute AudioContext time at which the sound starts. */
  when: number;
  /** 0..2. NaN falls back to 1. */
  volume: number;
  /** -1 (left) .. 1 (right). NaN falls back to 0. */
  pan: number;
  /**
   * Meaning depends on the sound: clinks, chips in a stack, cascade length, shuffle passes.
   * NaN falls back to the sound's default.
   */
  count?: number;
}

export interface Ambience {
  /** Fades the ambience out and releases every node. Safe to call more than once. */
  stop(): void;
}

// -- constants ---------------------------------------------------------------------------------

/** Exponential ramps cannot reach 0, so "silence" is -80 dB. */
const SILENCE = 0.0001;
const MIN_ATTACK_SECONDS = 0.0008;
const END_PADDING_SECONDS = 0.03;
const NOISE_BUFFER_SECONDS = 2;
const NOISE_TARGET_RMS = 0.4;
const DEFAULT_REVERB_SEND = 0.22;
const MAX_REPEAT_COUNT = 24;
const MAX_PARTIAL_FREQUENCY = 6500;

const CLICK_ATTACK_SECONDS = 0.0008;
const MIN_CLICK_DECAY_SECONDS = 0.003;

const IMPULSE_PRE_DELAY_SECONDS = 0.006;
const IMPULSE_DECAY_RATE = 6.9; // ln(1000): the tail ends 60 dB down

const AMBIENCE_ROOM_LOOP_SECONDS = 8;
const AMBIENCE_MURMUR_LOOP_SECONDS = 10;
const AMBIENCE_LOOP_CROSSFADE_SECONDS = 0.5;
const AMBIENCE_FADE_IN_SECONDS = 2.5;
const AMBIENCE_FADE_OUT_SECONDS = 1.6;
const ROOM_TONE_LEVEL = 0.06;
const MURMUR_LEVEL = 0.35;

// -- random helpers ----------------------------------------------------------------------------

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** value ± spread (relative), so repeated sounds never come out identical. */
function vary(value: number, spread: number): number {
  return value * (1 + (Math.random() * 2 - 1) * spread);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Math.min/max let NaN through, and an AudioParam assigned NaN throws, which would silently drop
 * the whole sound. Untrusted caller input therefore falls back to a safe default instead.
 */
function clampOrFallback(value: number | undefined, min: number, max: number, fallback: number): number {
  return value === undefined || Number.isNaN(value) ? fallback : clamp(value, min, max);
}

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

// -- noise and impulse generation --------------------------------------------------------------

function fillWhiteNoise(target: Float32Array): void {
  for (let index = 0; index < target.length; index += 1) {
    target[index] = Math.random() * 2 - 1;
  }
}

/** Paul Kellet's filtered-white approximation of -3 dB/octave noise. */
function fillPinkNoise(target: Float32Array): void {
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  for (let index = 0; index < target.length; index += 1) {
    const white = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.969 * b2 + white * 0.153852;
    b3 = 0.8665 * b3 + white * 0.3104856;
    b4 = 0.55 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.016898;
    target[index] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
    b6 = white * 0.115926;
  }
}

/** Leaky integrator: -6 dB/octave, stays bounded unlike a plain random walk. */
function fillBrownNoise(target: Float32Array): void {
  let last = 0;
  for (let index = 0; index < target.length; index += 1) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.02 * white) / 1.02;
    target[index] = last;
  }
}

const NOISE_GENERATORS: Record<NoiseKind, (target: Float32Array) => void> = {
  white: fillWhiteNoise,
  pink: fillPinkNoise,
  brown: fillBrownNoise,
};

/** Gives every noise colour the same loudness so envelopes mean the same thing for all of them. */
function normalizeNoiseLevel(samples: Float32Array): void {
  let energy = 0;
  for (let index = 0; index < samples.length; index += 1) {
    energy += samples[index] * samples[index];
  }
  const rms = Math.sqrt(energy / samples.length) || 1;
  const scale = NOISE_TARGET_RMS / rms;
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.tanh(samples[index] * scale);
  }
}

function createNoiseBuffer(context: BaseAudioContext, kind: NoiseKind): AudioBuffer {
  const length = Math.floor(context.sampleRate * NOISE_BUFFER_SECONDS);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const samples = buffer.getChannelData(0);
  NOISE_GENERATORS[kind](samples);
  normalizeNoiseLevel(samples);
  return buffer;
}

/** Generated once per context and reused by every sound (offsets are randomised at playback). */
export function createNoiseBuffers(context: BaseAudioContext): NoiseBuffers {
  return {
    white: createNoiseBuffer(context, 'white'),
    pink: createNoiseBuffer(context, 'pink'),
    brown: createNoiseBuffer(context, 'brown'),
  };
}

/**
 * Noise that loops without a click: the tail beyond the loop length is cross-faded into the head,
 * so the sample after the last one is the natural continuation of the stream.
 */
function createLoopingNoiseBuffer(context: BaseAudioContext, kind: NoiseKind, seconds: number): AudioBuffer {
  const length = Math.floor(context.sampleRate * seconds);
  const crossfade = Math.floor(context.sampleRate * AMBIENCE_LOOP_CROSSFADE_SECONDS);
  const raw = new Float32Array(length + crossfade);
  NOISE_GENERATORS[kind](raw);

  const buffer = context.createBuffer(1, length, context.sampleRate);
  const samples = buffer.getChannelData(0);
  samples.set(raw.subarray(0, length));
  for (let index = 0; index < crossfade; index += 1) {
    const progress = index / crossfade;
    samples[index] = raw[index] * Math.sqrt(progress) + raw[length + index] * Math.sqrt(1 - progress);
  }
  normalizeNoiseLevel(samples);
  return buffer;
}

/**
 * Small-room impulse response: a pre-delay, a few early reflections and an exponentially decaying
 * noise tail that gets darker over time (air absorption). Each channel uses different noise.
 */
export function createRoomImpulse(context: BaseAudioContext, seconds = 0.6): AudioBuffer {
  const sampleRate = context.sampleRate;
  const length = Math.floor(sampleRate * seconds);
  const preDelay = Math.floor(sampleRate * IMPULSE_PRE_DELAY_SECONDS);
  const impulse = context.createBuffer(2, length, sampleRate);

  for (let channel = 0; channel < 2; channel += 1) {
    const data = impulse.getChannelData(channel);
    let lowPassed = 0;
    for (let index = preDelay; index < length; index += 1) {
      const progress = (index - preDelay) / (length - preDelay);
      const envelope = Math.exp(-progress * IMPULSE_DECAY_RATE);
      const fadeIn = Math.min(1, (index - preDelay) / (sampleRate * 0.004));
      const brightness = 0.85 - 0.7 * progress;
      lowPassed += brightness * (Math.random() * 2 - 1 - lowPassed);
      data[index] = lowPassed * envelope * fadeIn;
    }
    addEarlyReflections(data, sampleRate, preDelay);
  }
  return impulse;
}

function addEarlyReflections(data: Float32Array, sampleRate: number, preDelay: number): void {
  for (let reflection = 0; reflection < 5; reflection += 1) {
    const position = preDelay + Math.floor(sampleRate * randomBetween(0.004, 0.035));
    if (position < data.length) {
      data[position] += (Math.random() < 0.5 ? -1 : 1) * randomBetween(0.25, 0.6) * (1 - reflection * 0.12);
    }
  }
}

// -- voices and primitives ---------------------------------------------------------------------

interface RenderRequest {
  env: SynthEnvironment;
  when: number;
  count: number;
  volume: number;
  pan: number;
}

interface VoiceOptions {
  /** Extra gain on top of the request volume. */
  gain?: number;
  panOffset?: number;
  /** Reverb send level (0..1). */
  reverb?: number;
}

/** One pan/gain/reverb strip. It disconnects itself once every source routed into it has ended. */
interface Voice {
  readonly env: SynthEnvironment;
  readonly input: AudioNode;
  track(source: AudioScheduledSourceNode): void;
}

function createVoice(request: RenderRequest, options: VoiceOptions = {}): Voice {
  const { env } = request;
  const { context } = env;
  const input = context.createGain();
  input.gain.value = request.volume * (options.gain ?? 1);
  const strip: AudioNode[] = [input];

  let tail: AudioNode = input;
  // Old Safari has no StereoPannerNode: sounds simply stay centred there.
  if (typeof context.createStereoPanner === 'function') {
    const panner = context.createStereoPanner();
    panner.pan.value = clamp(request.pan + (options.panOffset ?? 0), -1, 1);
    input.connect(panner);
    strip.push(panner);
    tail = panner;
  }

  const send = context.createGain();
  send.gain.value = options.reverb ?? DEFAULT_REVERB_SEND;
  tail.connect(env.output);
  tail.connect(send);
  send.connect(env.reverbSend);
  strip.push(send);

  let liveSources = 0;
  return {
    env,
    input,
    track(source) {
      liveSources += 1;
      source.addEventListener(
        'ended',
        () => {
          liveSources -= 1;
          if (liveSources === 0) {
            for (const node of strip) node.disconnect();
          }
        },
        { once: true },
      );
    },
  };
}

interface Envelope {
  peak: number;
  attack: number;
  decay: number;
  /** Time spent at the peak before decaying. */
  hold?: number;
}

/** Exponential attack and decay (a natural loudness curve). Returns the time the sound is silent. */
function scheduleEnvelope(param: AudioParam, at: number, envelope: Envelope): number {
  const peak = Math.max(envelope.peak, SILENCE);
  const peakTime = at + Math.max(envelope.attack, MIN_ATTACK_SECONDS);
  const releaseTime = peakTime + (envelope.hold ?? 0);
  const endTime = releaseTime + envelope.decay;

  param.setValueAtTime(SILENCE, at);
  param.exponentialRampToValueAtTime(peak, peakTime);
  if (releaseTime > peakTime) param.setValueAtTime(peak, releaseTime);
  param.exponentialRampToValueAtTime(SILENCE, endTime);
  return endTime;
}

interface FilterSpec {
  type: BiquadFilterType;
  frequency: number;
  q?: number;
  /** When set, the cutoff glides exponentially to this value over the whole sound. */
  endFrequency?: number;
}

function createFilter(context: BaseAudioContext, spec: FilterSpec, from: number, to: number): BiquadFilterNode {
  const filter = context.createBiquadFilter();
  filter.type = spec.type;
  filter.Q.value = spec.q ?? 0.7;
  filter.frequency.setValueAtTime(spec.frequency, from);
  if (spec.endFrequency !== undefined) {
    filter.frequency.exponentialRampToValueAtTime(spec.endFrequency, to);
  }
  return filter;
}

interface NoiseSpec {
  kind: NoiseKind;
  at: number;
  envelope: Envelope;
  filters: FilterSpec[];
}

function playNoise(voice: Voice, spec: NoiseSpec): void {
  const { context, noise } = voice.env;
  const buffer = noise[spec.kind];
  const gain = context.createGain();
  gain.gain.value = SILENCE;
  const endTime = scheduleEnvelope(gain.gain, spec.at, spec.envelope);

  const source = context.createBufferSource();
  source.buffer = buffer;
  let node: AudioNode = source;
  for (const filterSpec of spec.filters) {
    const filter = createFilter(context, filterSpec, spec.at, endTime);
    node.connect(filter);
    node = filter;
  }
  node.connect(gain);
  gain.connect(voice.input);

  const length = endTime - spec.at + END_PADDING_SECONDS;
  const offset = Math.random() * Math.max(0, buffer.duration - length);
  source.start(spec.at, offset, Math.min(length, buffer.duration - offset));
  voice.track(source);
}

interface ToneSpec {
  type: OscillatorType;
  frequency: number;
  at: number;
  envelope: Envelope;
  /** Exponential pitch glide target, reached after `glide` seconds (defaults to the decay time). */
  endFrequency?: number;
  glide?: number;
  detuneCents?: number;
  /** Route through a shared node (e.g. a low-pass) instead of straight into the voice. */
  destination?: AudioNode;
}

function playTone(voice: Voice, spec: ToneSpec): void {
  const { context } = voice.env;
  const oscillator = context.createOscillator();
  oscillator.type = spec.type;
  oscillator.frequency.setValueAtTime(spec.frequency, spec.at);
  if (spec.endFrequency !== undefined) {
    oscillator.frequency.exponentialRampToValueAtTime(spec.endFrequency, spec.at + (spec.glide ?? spec.envelope.decay));
  }
  if (spec.detuneCents) oscillator.detune.value = spec.detuneCents;

  const gain = context.createGain();
  gain.gain.value = SILENCE;
  const endTime = scheduleEnvelope(gain.gain, spec.at, spec.envelope);
  oscillator.connect(gain);
  gain.connect(spec.destination ?? voice.input);

  oscillator.start(spec.at);
  oscillator.stop(endTime + END_PADDING_SECONDS);
  voice.track(oscillator);
}

interface Click {
  time: number;
  peak: number;
  decay: number;
  frequency: number;
}

interface ClickTrainSpec {
  clicks: Click[];
  filterType: BiquadFilterType;
  q: number;
}

/**
 * Many tiny clicks (riffles, grains) cost one noise source, one filter and one gain: each click is
 * only envelope automation on the shared gain. Clicks must be at least ~8 ms apart.
 */
function playClickTrain(voice: Voice, spec: ClickTrainSpec): void {
  if (spec.clicks.length === 0) return;
  const { context, noise } = voice.env;
  const clicks = [...spec.clicks].sort((a, b) => a.time - b.time);
  const firstTime = clicks[0].time;

  const filter = context.createBiquadFilter();
  filter.type = spec.filterType;
  filter.Q.value = spec.q;
  filter.frequency.value = clicks[0].frequency;
  const gain = context.createGain();
  gain.gain.value = SILENCE;

  let silentAfter = firstTime;
  clicks.forEach((click, index) => {
    const nextTime = clicks[index + 1]?.time ?? Number.POSITIVE_INFINITY;
    const room = nextTime - click.time - CLICK_ATTACK_SECONDS - 0.0005;
    const decay = Math.max(MIN_CLICK_DECAY_SECONDS, Math.min(click.decay, room));
    const peakTime = click.time + CLICK_ATTACK_SECONDS;
    gain.gain.setValueAtTime(SILENCE, click.time);
    gain.gain.exponentialRampToValueAtTime(Math.max(click.peak, SILENCE), peakTime);
    gain.gain.exponentialRampToValueAtTime(SILENCE, peakTime + decay);
    filter.frequency.setValueAtTime(click.frequency, click.time);
    silentAfter = peakTime + decay;
  });

  const source = context.createBufferSource();
  source.buffer = noise.white;
  source.loop = true;
  source.connect(filter);
  filter.connect(gain);
  gain.connect(voice.input);
  source.start(firstTime, Math.random() * noise.white.duration);
  source.stop(silentAfter + END_PADDING_SECONDS);
  voice.track(source);
}

// -- chips -------------------------------------------------------------------------------------

interface ClinkPartial {
  ratio: number;
  type: OscillatorType;
  level: number;
  decay: number;
}

/** Ratios are deliberately inharmonic: that is what makes ceramic chips sound like chips. */
const CLINK_PARTIALS: readonly ClinkPartial[] = [
  { ratio: 1, type: 'sine', level: 0.26, decay: 0.12 },
  { ratio: 1.58, type: 'triangle', level: 0.14, decay: 0.07 },
  { ratio: 2.32, type: 'sine', level: 0.1, decay: 0.045 },
];

interface ClinkOptions {
  strength: number;
  /** Multiplies the base pitch; < 1 sounds like heavier chips on a stack. */
  brightness?: number;
  /** Adds a low "thud" of the chip landing on other chips. */
  body?: number;
}

function scheduleClink(voice: Voice, at: number, options: ClinkOptions): void {
  const baseFrequency = vary(2900, 0.14) * (options.brightness ?? 1);
  const partialCount = Math.random() < 0.35 ? 2 : CLINK_PARTIALS.length;

  for (const partial of CLINK_PARTIALS.slice(0, partialCount)) {
    playTone(voice, {
      type: partial.type,
      frequency: Math.min(baseFrequency * vary(partial.ratio, 0.04), MAX_PARTIAL_FREQUENCY),
      at,
      envelope: {
        peak: partial.level * options.strength,
        attack: 0.0006,
        decay: vary(partial.decay, 0.25),
      },
    });
  }

  playNoise(voice, {
    kind: 'white',
    at,
    envelope: { peak: 0.5 * options.strength, attack: 0.0006, decay: 0.006 },
    filters: [{ type: 'highpass', frequency: 4500 }],
  });

  if (options.body) {
    playTone(voice, {
      type: 'sine',
      frequency: vary(340, 0.1),
      endFrequency: 220,
      at,
      envelope: { peak: 0.1 * options.body * options.strength, attack: 0.001, decay: 0.035 },
    });
  }
}

function renderChipClink(request: RenderRequest): void {
  const voice = createVoice(request, { reverb: 0.26 });
  let at = request.when;
  for (let index = 0; index < request.count; index += 1) {
    scheduleClink(voice, at, { strength: vary(1, 0.15) * (index === 0 ? 1 : 0.85) });
    at += randomBetween(0.025, 0.06);
  }
}

function renderChipStack(request: RenderRequest): void {
  const voice = createVoice(request, { reverb: 0.2 });
  let at = request.when;
  let spacing = randomBetween(0.06, 0.085);
  for (let index = 0; index < request.count; index += 1) {
    const isLast = index === request.count - 1;
    scheduleClink(voice, at, {
      strength: vary(isLast ? 0.95 : 0.7, 0.15),
      brightness: vary(0.85, 0.08),
      body: 1,
    });
    at += spacing * randomBetween(0.8, 1.2);
    spacing = Math.max(0.035, spacing * 0.92);
  }
}

function renderChipsSlide(request: RenderRequest): void {
  const voice = createVoice(request, { reverb: 0.2 });
  const duration = vary(0.5, 0.15);

  const grains: Click[] = [];
  for (let offset = 0; offset < duration; offset += randomBetween(0.009, 0.018)) {
    const swell = Math.sin(Math.PI * (offset / duration)) ** 0.8;
    grains.push({
      time: request.when + offset,
      peak: randomBetween(0.3, 0.9) * swell,
      decay: 0.01,
      frequency: randomBetween(2200, 6000),
    });
  }
  playClickTrain(voice, { clicks: grains, filterType: 'bandpass', q: 0.8 });

  playNoise(voice, {
    kind: 'brown',
    at: request.when,
    envelope: { peak: 0.15, attack: duration * 0.25, decay: duration * 0.75 },
    filters: [{ type: 'lowpass', frequency: 700 }],
  });

  for (let index = 0; index < request.count; index += 1) {
    scheduleClink(voice, request.when + randomBetween(0.04, duration * 0.95), {
      strength: randomBetween(0.35, 0.7),
      brightness: vary(0.95, 0.08),
    });
  }
}

function renderPotCollect(request: RenderRequest): void {
  const voice = createVoice(request, { reverb: 0.32 });
  let at = request.when;
  let spacing = randomBetween(0.06, 0.08);
  for (let index = 0; index < request.count; index += 1) {
    scheduleClink(voice, at, { strength: vary(0.85 - index * 0.025, 0.12), brightness: vary(1, 0.1) });
    at += spacing * randomBetween(0.75, 1.25);
    spacing = Math.max(0.03, spacing * 0.95);
  }
  // Two brighter clinks close the cascade like a till drawer settling.
  scheduleClink(voice, at + 0.04, { strength: 0.8, brightness: 1.3 });
  scheduleClink(voice, at + 0.11, { strength: 0.65, brightness: 1.45 });

  playNoise(voice, {
    kind: 'pink',
    at: request.when,
    envelope: { peak: 0.3, attack: 0.12, decay: Math.max(0.2, at - request.when) },
    filters: [{ type: 'bandpass', frequency: 1800, q: 0.7 }],
  });
}

// -- cards -------------------------------------------------------------------------------------

function renderCardSlide(request: RenderRequest): void {
  const voice = createVoice(request, { reverb: 0.16 });
  const duration = vary(0.17, 0.2);
  const startFrequency = vary(1700, 0.15);

  playNoise(voice, {
    kind: 'pink',
    at: request.when,
    envelope: { peak: vary(0.9, 0.12), attack: duration * 0.35, decay: duration * 0.65 },
    filters: [{ type: 'bandpass', frequency: startFrequency, endFrequency: startFrequency * 2.3, q: 0.9 }],
  });
  // Soft cloth tail under the sweep.
  playNoise(voice, {
    kind: 'brown',
    at: request.when + duration * 0.2,
    envelope: { peak: vary(0.2, 0.15), attack: 0.03, decay: duration },
    filters: [{ type: 'lowpass', frequency: 1100 }],
  });
}

function renderCardSnap(request: RenderRequest): void {
  const voice = createVoice(request, { reverb: 0.2 });
  playNoise(voice, {
    kind: 'white',
    at: request.when,
    envelope: { peak: vary(0.55, 0.15), attack: 0.0008, decay: vary(0.03, 0.2) },
    filters: [{ type: 'highpass', frequency: vary(2600, 0.12) }],
  });
  playTone(voice, {
    type: 'sine',
    frequency: vary(190, 0.1),
    endFrequency: 110,
    at: request.when,
    envelope: { peak: 0.18, attack: 0.001, decay: 0.05 },
  });
}

function renderCardFlip(request: RenderRequest): void {
  const voice = createVoice(request, { reverb: 0.25 });
  const gap = vary(0.06, 0.2);

  playClickTrain(voice, {
    filterType: 'bandpass',
    q: 1.4,
    clicks: [
      { time: request.when, peak: vary(0.95, 0.1), decay: 0.018, frequency: vary(3200, 0.1) },
      { time: request.when + gap, peak: vary(0.8, 0.1), decay: 0.016, frequency: vary(3800, 0.1) },
    ],
  });
  // The air pushed out while the card turns over.
  playNoise(voice, {
    kind: 'pink',
    at: request.when + 0.004,
    envelope: { peak: 0.35, attack: gap * 0.5, decay: gap * 0.8 },
    filters: [{ type: 'bandpass', frequency: 1400, endFrequency: 3400, q: 0.8 }],
  });
}

const RIFFLE_CLICKS = 24;
const CASCADE_CLICKS = 14;
const MIN_RIFFLE_SPACING_SECONDS = 0.012;

/** Appends one riffle (accelerating clicks) plus the bridge cascade; returns the time it ends. */
function appendRiffle(clicks: Click[], startTime: number): number {
  let time = startTime;
  let spacing = vary(0.034, 0.15);
  for (let index = 0; index < RIFFLE_CLICKS; index += 1) {
    clicks.push({ time, peak: randomBetween(0.45, 0.95), decay: 0.012, frequency: randomBetween(2400, 5200) });
    time += spacing * randomBetween(0.8, 1.2);
    spacing = Math.max(MIN_RIFFLE_SPACING_SECONDS, spacing * 0.93);
  }
  for (let index = 0; index < CASCADE_CLICKS; index += 1) {
    const fade = 1 - index / CASCADE_CLICKS;
    clicks.push({ time, peak: randomBetween(0.3, 0.7) * fade, decay: 0.01, frequency: randomBetween(2800, 5600) });
    time += randomBetween(0.011, 0.02);
  }
  return time;
}

function renderShuffle(request: RenderRequest): void {
  const voice = createVoice(request, { reverb: 0.24 });
  const passes = clamp(request.count, 1, 3);
  const clicks: Click[] = [];
  let cursor = request.when;
  for (let pass = 0; pass < passes; pass += 1) {
    cursor = appendRiffle(clicks, cursor) + vary(0.14, 0.2);
  }
  // Squaring the deck against the table.
  clicks.push({ time: cursor, peak: 0.9, decay: 0.02, frequency: 1500 });
  clicks.push({ time: cursor + vary(0.1, 0.15), peak: 0.75, decay: 0.02, frequency: 1300 });
  playClickTrain(voice, { clicks, filterType: 'bandpass', q: 1.1 });

  const span = cursor - request.when;
  playNoise(voice, {
    kind: 'pink',
    at: request.when,
    envelope: { peak: 0.45, attack: span * 0.6, decay: span * 0.4 },
    filters: [{ type: 'bandpass', frequency: 2200, q: 0.5 }],
  });
}

function renderFold(request: RenderRequest): void {
  const voice = createVoice(request, { reverb: 0.2 });
  const duration = vary(0.24, 0.15);
  const landing = request.when + duration * 0.45;

  playNoise(voice, {
    kind: 'pink',
    at: request.when,
    envelope: { peak: 0.75, attack: duration * 0.3, decay: duration * 0.7 },
    filters: [{ type: 'bandpass', frequency: vary(2600, 0.1), endFrequency: 900, q: 0.9 }],
  });
  // The cards land on the muck pile.
  playTone(voice, {
    type: 'sine',
    frequency: vary(130, 0.1),
    endFrequency: 90,
    at: landing,
    envelope: { peak: 0.18, attack: 0.002, decay: 0.09 },
  });
  playNoise(voice, {
    kind: 'white',
    at: landing,
    envelope: { peak: 0.25, attack: 0.001, decay: 0.02 },
    filters: [{ type: 'highpass', frequency: 3000 }],
  });
}

// -- table knock, timer ticks ------------------------------------------------------------------

function scheduleKnock(voice: Voice, at: number, strength: number, pitchScale: number): void {
  const frequency = vary(165, 0.12) * pitchScale;
  playTone(voice, {
    type: 'sine',
    frequency,
    endFrequency: frequency * 0.55,
    glide: 0.07,
    at,
    envelope: { peak: 0.4 * strength, attack: 0.002, decay: 0.11 },
  });
  playNoise(voice, {
    kind: 'brown',
    at,
    envelope: { peak: 0.3 * strength, attack: 0.002, decay: 0.05 },
    filters: [{ type: 'lowpass', frequency: 450 }],
  });
  playNoise(voice, {
    kind: 'white',
    at,
    envelope: { peak: 0.22 * strength, attack: 0.0008, decay: 0.012 },
    filters: [{ type: 'bandpass', frequency: 1600, q: 1.2 }],
  });
}

function renderKnock(request: RenderRequest): void {
  const voice = createVoice(request, { reverb: 0.14 });
  scheduleKnock(voice, request.when, 1, 1);
  scheduleKnock(voice, request.when + vary(0.13, 0.15), 0.85, vary(1.05, 0.03));
}

/** Woodblock tick: a short pitched body plus a dry click. Urgent ticks are higher and brighter. */
function renderTick(request: RenderRequest, urgent: boolean): void {
  const voice = createVoice(request, { reverb: 0.1 });
  const frequency = vary(urgent ? 2300 : 1650, 0.03);
  const decay = urgent ? 0.07 : 0.05;

  playTone(voice, {
    type: 'sine',
    frequency,
    endFrequency: frequency * 0.93,
    at: request.when,
    envelope: { peak: urgent ? 0.34 : 0.28, attack: 0.001, decay },
  });
  playTone(voice, {
    type: 'triangle',
    frequency: frequency * 2.4,
    at: request.when,
    envelope: { peak: urgent ? 0.18 : 0.1, attack: 0.001, decay: decay * 0.45 },
  });
  playNoise(voice, {
    kind: 'white',
    at: request.when,
    envelope: { peak: urgent ? 0.5 : 0.32, attack: 0.0008, decay: 0.008 },
    filters: [{ type: 'bandpass', frequency: frequency * 1.6, q: 1.2 }],
  });
}

// -- melodic sounds ----------------------------------------------------------------------------

interface BellPartial {
  ratio: number;
  level: number;
  decay: number;
}

const BELL_PARTIALS: readonly BellPartial[] = [
  { ratio: 1, level: 0.2, decay: 1.1 },
  { ratio: 2, level: 0.07, decay: 0.6 },
  { ratio: 2.76, level: 0.03, decay: 0.35 },
  { ratio: 4.07, level: 0.012, decay: 0.2 },
];

function scheduleBell(voice: Voice, at: number, frequency: number, level: number): void {
  const detuneCents = randomBetween(-6, 6);
  for (const partial of BELL_PARTIALS) {
    playTone(voice, {
      type: 'sine',
      frequency: frequency * partial.ratio,
      at,
      detuneCents,
      envelope: { peak: partial.level * level, attack: 0.006, decay: partial.decay },
    });
  }
}

function renderYourTurn(request: RenderRequest): void {
  const voice = createVoice(request, { reverb: 0.5 });
  scheduleBell(voice, request.when, vary(783.99, 0.002), 1); // G5
  scheduleBell(voice, request.when + vary(0.15, 0.1), vary(1046.5, 0.002), 1.1); // C6
}

function renderAllIn(request: RenderRequest): void {
  const voice = createVoice(request, { reverb: 0.45 });
  const { when } = request;

  playTone(voice, {
    type: 'sine',
    frequency: vary(95, 0.06),
    endFrequency: 34,
    glide: 0.6,
    at: when,
    envelope: { peak: 0.5, attack: 0.004, decay: 1.1 },
  });
  playNoise(voice, {
    kind: 'brown',
    at: when,
    envelope: { peak: 0.65, attack: 0.003, decay: 0.4 },
    filters: [{ type: 'lowpass', frequency: 260 }],
  });
  playNoise(voice, {
    kind: 'white',
    at: when,
    envelope: { peak: 0.25, attack: 0.001, decay: 0.05 },
    filters: [{ type: 'highpass', frequency: 1800 }],
  });

  // Tension riser that blooms right after the hit and dissolves into the reverb.
  const riserLowpass = voice.env.context.createBiquadFilter();
  riserLowpass.type = 'lowpass';
  riserLowpass.Q.value = 0.7;
  riserLowpass.frequency.setValueAtTime(400, when);
  riserLowpass.frequency.exponentialRampToValueAtTime(3200, when + 0.9);
  riserLowpass.connect(voice.input);
  for (const detuneCents of [-7, 7]) {
    playTone(voice, {
      type: 'sawtooth',
      frequency: 220,
      endFrequency: 660,
      glide: 0.9,
      at: when,
      detuneCents,
      destination: riserLowpass,
      envelope: { peak: 0.04, attack: 0.7, decay: 0.5 },
    });
  }
  playNoise(voice, {
    kind: 'pink',
    at: when,
    envelope: { peak: 0.2, attack: 0.8, decay: 0.4 },
    filters: [{ type: 'bandpass', frequency: 500, endFrequency: 4000, q: 1.2 }],
  });
}

const FANFARE_ARPEGGIO = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
const FANFARE_CHORD = [261.63, 329.63, 392, 523.25]; // C4 E4 G4 C5
const SPARKLE_FREQUENCIES = [2093, 2637, 3136, 3520, 3951];
const SPARKLE_COUNT = 8;

function scheduleFanfareNote(
  voice: Voice,
  destination: AudioNode,
  frequency: number,
  at: number,
  shape: { level: number; hold: number; decay: number },
): void {
  const envelope = { peak: shape.level, attack: 0.008, hold: shape.hold, decay: shape.decay };
  playTone(voice, { type: 'triangle', frequency, at, envelope, destination });
  playTone(voice, {
    type: 'sawtooth',
    frequency,
    at,
    detuneCents: 6,
    destination,
    envelope: { ...envelope, peak: shape.level * 0.3 },
  });
}

function scheduleSparkles(request: RenderRequest): void {
  for (let index = 0; index < SPARKLE_COUNT; index += 1) {
    const sparkleVoice = createVoice(request, {
      gain: 0.5,
      panOffset: randomBetween(-0.6, 0.6),
      reverb: 0.6,
    });
    playTone(sparkleVoice, {
      type: 'sine',
      frequency: pick(SPARKLE_FREQUENCIES) * vary(1, 0.004),
      at: request.when + 0.28 + Math.random() * 0.8,
      envelope: { peak: randomBetween(0.05, 0.1), attack: 0.002, decay: randomBetween(0.2, 0.4) },
    });
  }
}

function renderWin(request: RenderRequest): void {
  const voice = createVoice(request, { reverb: 0.5 });
  // Rolling the highs off keeps the saw from sounding like a synth lead.
  const warmth = voice.env.context.createBiquadFilter();
  warmth.type = 'lowpass';
  warmth.frequency.value = 2600;
  warmth.Q.value = 0.5;
  warmth.connect(voice.input);

  const step = vary(0.085, 0.08);
  FANFARE_ARPEGGIO.forEach((frequency, index) => {
    scheduleFanfareNote(voice, warmth, frequency, request.when + index * step, { level: 0.16, hold: 0.05, decay: 0.5 });
  });
  const chordStart = request.when + FANFARE_ARPEGGIO.length * step + 0.02;
  for (const frequency of FANFARE_CHORD) {
    scheduleFanfareNote(voice, warmth, frequency, chordStart, { level: 0.12, hold: 0.45, decay: 1.2 });
  }
  scheduleSparkles(request);
}

function renderUiClick(request: RenderRequest): void {
  const voice = createVoice(request, { reverb: 0.06 });
  playTone(voice, {
    type: 'sine',
    frequency: vary(1250, 0.04),
    endFrequency: 880,
    at: request.when,
    envelope: { peak: 0.16, attack: 0.001, decay: 0.035 },
  });
  playNoise(voice, {
    kind: 'white',
    at: request.when,
    envelope: { peak: 0.2, attack: 0.0008, decay: 0.008 },
    filters: [{ type: 'highpass', frequency: 3500 }],
  });
}

// -- public sound API --------------------------------------------------------------------------

interface SoundDefinition {
  render: (request: RenderRequest) => void;
  defaultCount: number;
}

const SOUND_DEFINITIONS: Record<SoundName, SoundDefinition> = {
  cardSlide: { render: renderCardSlide, defaultCount: 1 },
  cardSnap: { render: renderCardSnap, defaultCount: 1 },
  cardFlip: { render: renderCardFlip, defaultCount: 1 },
  shuffle: { render: renderShuffle, defaultCount: 1 },
  chipClink: { render: renderChipClink, defaultCount: 1 },
  chipStack: { render: renderChipStack, defaultCount: 4 },
  chipsSlide: { render: renderChipsSlide, defaultCount: 4 },
  knock: { render: renderKnock, defaultCount: 1 },
  fold: { render: renderFold, defaultCount: 1 },
  tick: { render: (request) => renderTick(request, false), defaultCount: 1 },
  tickUrgent: { render: (request) => renderTick(request, true), defaultCount: 1 },
  yourTurn: { render: renderYourTurn, defaultCount: 1 },
  allIn: { render: renderAllIn, defaultCount: 1 },
  win: { render: renderWin, defaultCount: 1 },
  potCollect: { render: renderPotCollect, defaultCount: 6 },
  uiClick: { render: renderUiClick, defaultCount: 1 },
};

export const SOUND_NAMES = Object.keys(SOUND_DEFINITIONS) as SoundName[];

/** Schedules one sound on the environment's context. Unknown names are ignored. */
export function playSynthSound(env: SynthEnvironment, name: SoundName, options: SynthPlayOptions): void {
  const definition = SOUND_DEFINITIONS[name] as SoundDefinition | undefined;
  if (!definition) return;
  const now = env.context.currentTime;
  definition.render({
    env,
    when: Number.isNaN(options.when) ? now : Math.max(options.when, now),
    count: Math.round(clampOrFallback(options.count, 1, MAX_REPEAT_COUNT, definition.defaultCount)),
    volume: clampOrFallback(options.volume, 0, 2, 1),
    pan: clampOrFallback(options.pan, -1, 1, 0),
  });
}

// -- ambience ----------------------------------------------------------------------------------

interface AmbienceBuffers {
  room: AudioBuffer;
  murmur: AudioBuffer;
}

const ambienceBufferCache = new WeakMap<BaseAudioContext, AmbienceBuffers>();

function getAmbienceBuffers(context: BaseAudioContext): AmbienceBuffers {
  let buffers = ambienceBufferCache.get(context);
  if (!buffers) {
    buffers = {
      room: createLoopingNoiseBuffer(context, 'brown', AMBIENCE_ROOM_LOOP_SECONDS),
      murmur: createLoopingNoiseBuffer(context, 'pink', AMBIENCE_MURMUR_LOOP_SECONDS),
    };
    ambienceBufferCache.set(context, buffers);
  }
  return buffers;
}

function createLoopingSource(context: BaseAudioContext, buffer: AudioBuffer): AudioBufferSourceNode {
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  return source;
}

function addSlowModulation(
  context: BaseAudioContext,
  param: AudioParam,
  rate: number,
  depth: number,
  sources: AudioScheduledSourceNode[],
): void {
  const oscillator = context.createOscillator();
  oscillator.frequency.value = rate * randomBetween(0.9, 1.1);
  const amount = context.createGain();
  amount.gain.value = depth;
  oscillator.connect(amount);
  amount.connect(param);
  sources.push(oscillator);
}

interface Formant {
  frequency: number;
  q: number;
  swellRate: number;
  syllableRate: number;
}

/** Three vowel-ish bands whose levels drift at unrelated rates read as far-away conversation. */
const MURMUR_FORMANTS: readonly Formant[] = [
  { frequency: 420, q: 2.2, swellRate: 0.09, syllableRate: 3.1 },
  { frequency: 780, q: 2.6, swellRate: 0.14, syllableRate: 4.3 },
  { frequency: 1350, q: 3, swellRate: 0.21, syllableRate: 3.7 },
];

function buildRoomTone(
  context: BaseAudioContext,
  buffer: AudioBuffer,
  destination: AudioNode,
  sources: AudioScheduledSourceNode[],
): void {
  const source = createLoopingSource(context, buffer);
  const lowpass = context.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = 420;
  lowpass.Q.value = 0.6;
  const level = context.createGain();
  level.gain.value = ROOM_TONE_LEVEL;
  source.connect(lowpass);
  lowpass.connect(level);
  level.connect(destination);
  sources.push(source);
}

function buildMurmur(
  context: BaseAudioContext,
  buffer: AudioBuffer,
  destination: AudioNode,
  sources: AudioScheduledSourceNode[],
): void {
  const source = createLoopingSource(context, buffer);
  const smoothing = context.createBiquadFilter();
  smoothing.type = 'lowpass';
  smoothing.frequency.value = 1800;
  const level = context.createGain();
  level.gain.value = MURMUR_LEVEL;
  smoothing.connect(level);
  level.connect(destination);

  for (const formant of MURMUR_FORMANTS) {
    const band = context.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = formant.frequency;
    band.Q.value = formant.q;
    const bandLevel = context.createGain();
    bandLevel.gain.value = 0.5;
    source.connect(band);
    band.connect(bandLevel);
    bandLevel.connect(smoothing);
    addSlowModulation(context, bandLevel.gain, formant.swellRate, 0.35, sources);
    addSlowModulation(context, bandLevel.gain, formant.syllableRate, 0.12, sources);
  }
  sources.push(source);
}

/**
 * Very quiet room tone plus a distant murmur. Starts fading in immediately; call `stop()` to fade
 * out and free everything (a new one can be created later at no extra buffer cost).
 */
export function createRoomAmbience(context: BaseAudioContext, destination: AudioNode): Ambience {
  const buffers = getAmbienceBuffers(context);
  const fade = context.createGain();
  fade.gain.value = 0;
  fade.connect(destination);

  const sources: AudioScheduledSourceNode[] = [];
  buildRoomTone(context, buffers.room, fade, sources);
  buildMurmur(context, buffers.murmur, fade, sources);

  const startTime = context.currentTime;
  fade.gain.setTargetAtTime(1, startTime, AMBIENCE_FADE_IN_SECONDS / 3);
  for (const source of sources) source.start(startTime);

  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      const now = context.currentTime;
      fade.gain.setTargetAtTime(0, now, AMBIENCE_FADE_OUT_SECONDS / 4);
      const endTime = now + AMBIENCE_FADE_OUT_SECONDS + 0.1;
      for (const source of sources) source.stop(endTime);
      sources[0].addEventListener('ended', () => fade.disconnect(), { once: true });
    },
  };
}
