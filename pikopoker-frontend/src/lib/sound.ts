// Short UI sound effects, synthesized live via the Web Audio API instead of
// shipped as audio files -- keeps the bundle light and sidesteps sourcing/
// licensing real samples for a handful of one-off cues. Every call is
// wrapped so a failure (no AudioContext, autoplay policy, muted) is a
// silent no-op -- sound is decoration, never allowed to break gameplay.
//
// 2026-09-12: rebuilt every cue around filtered noise instead of plain
// oscillator tones (square/triangle waves read as "chiptune"/8-bit --
// the dev: "ca fait trop numerique... faut les sons comme si c'etait des
// vraies cartes"). Real cards and chips are noisy, textured, and never
// sound perfectly identical twice -- small random jitter on pitch/duration
// is deliberate, not sloppiness, so repeated cues (many chip clacks, many
// card deals) don't sound like the same sample looping.

const MUTE_KEY = "pikopoker.muted";

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) ctx = new Ctor();
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

export function isMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setMuted(muted: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
  } catch {
    // per-viewer convenience only -- fine to lose across sessions
  }
}

function play(fn: (audioCtx: AudioContext) => void): void {
  if (isMuted()) return;
  const audioCtx = getCtx();
  if (!audioCtx) return;
  try {
    fn(audioCtx);
  } catch {
    // ignore -- see file header
  }
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function envelope(gain: GainNode, audioCtx: AudioContext, at: number, attack: number, peak: number, release: number): void {
  const start = audioCtx.currentTime + at;
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(peak, start + attack);
  gain.gain.exponentialRampToValueAtTime(0.001, start + attack + release);
}

// Plain white noise, linearly decaying to silence -- the raw material for
// every "physical" cue below (a pure oscillator tone is what reads as
// synthetic/digital; noise shaped by a filter is what reads as a real
// object hitting another real object).
function noiseBuffer(audioCtx: AudioContext, duration: number): AudioBuffer {
  const size = Math.max(1, Math.floor(audioCtx.sampleRate * duration));
  const buffer = audioCtx.createBuffer(1, size, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < size; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / size);
  return buffer;
}

// A quick decaying burst of bandpass-filtered noise -- reads as a crisp
// card slide/flip. Frequency/duration jitter slightly per call so a run of
// several deals doesn't sound like one sample looping.
function cardSnap(audioCtx: AudioContext, at: number): void {
  const duration = rand(0.06, 0.09);
  const source = audioCtx.createBufferSource();
  source.buffer = noiseBuffer(audioCtx, duration);
  const filter = audioCtx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = rand(2400, 3400);
  filter.Q.value = rand(0.8, 1.4);
  const gain = audioCtx.createGain();
  gain.gain.value = 0.16;
  source.connect(filter);
  filter.connect(gain);
  gain.connect(audioCtx.destination);
  const start = audioCtx.currentTime + at;
  source.start(start);
  source.stop(start + duration + 0.02);
}

/** One or more cards being dealt/revealed. */
export function playCardSound(count = 1): void {
  play((audioCtx) => {
    for (let i = 0; i < Math.min(count, 5); i++) cardSnap(audioCtx, i * 0.065 + rand(0, 0.012));
  });
}

// A single chip knocking into a pile: a highpass-noise "tik" (the plastic/
// clay impact) plus a very short resonant ring on top (the faint ceramic
// ping real chips have) -- not a musical note, just enough tone to read as
// a solid object rather than a dry click.
function chipClack(audioCtx: AudioContext, at: number, pitch = 1): void {
  const start = audioCtx.currentTime + at;

  const duration = 0.045;
  const source = audioCtx.createBufferSource();
  source.buffer = noiseBuffer(audioCtx, duration);
  const filter = audioCtx.createBiquadFilter();
  filter.type = "highpass";
  filter.frequency.value = 3200 * pitch;
  const noiseGain = audioCtx.createGain();
  noiseGain.gain.value = 0.09;
  source.connect(filter);
  filter.connect(noiseGain);
  noiseGain.connect(audioCtx.destination);
  source.start(start);
  source.stop(start + duration + 0.01);

  const osc = audioCtx.createOscillator();
  const oscGain = audioCtx.createGain();
  osc.type = "triangle";
  osc.frequency.value = rand(1400, 1700) * pitch;
  osc.connect(oscGain);
  oscGain.connect(audioCtx.destination);
  envelope(oscGain, audioCtx, at, 0.001, 0.045, 0.05);
  osc.start(start);
  osc.stop(start + 0.08);
}

/** A bet, call, or raise landing -- a couple of chips clacking into the pot. */
export function playChipSound(): void {
  play((audioCtx) => {
    chipClack(audioCtx, 0, 1);
    chipClack(audioCtx, rand(0.03, 0.05), rand(0.92, 1.08));
  });
}

/** Folding -- cards being slid face-down across the felt: a soft, quiet swipe, not a tone. */
export function playFoldSound(): void {
  play((audioCtx) => {
    const duration = 0.22;
    const source = audioCtx.createBufferSource();
    source.buffer = noiseBuffer(audioCtx, duration);
    const filter = audioCtx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(1400, audioCtx.currentTime);
    filter.frequency.exponentialRampToValueAtTime(300, audioCtx.currentTime + duration);
    const gain = audioCtx.createGain();
    source.connect(filter);
    filter.connect(gain);
    gain.connect(audioCtx.destination);
    envelope(gain, audioCtx, 0, 0.01, 0.09, duration);
    source.start(audioCtx.currentTime);
    source.stop(audioCtx.currentTime + duration + 0.02);
  });
}

/** Winning a hand -- chips being scooped and stacked toward the winner, not a musical chime. */
export function playWinSound(): void {
  play((audioCtx) => {
    const clacks = 7;
    let at = 0;
    for (let i = 0; i < clacks; i++) {
      chipClack(audioCtx, at, rand(0.85, 1.15));
      at += rand(0.045, 0.07);
    }
  });
}
