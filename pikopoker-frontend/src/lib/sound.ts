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
//
// 2026-09-15: second realism pass, same ask again ("ameliorer les effets
// sonores... aspect plus realiste et moins numerique"). Two changes: (1)
// split the one generic "card" cue into playDealSound (a felt slide +
// soft landing tap, for cards being dealt out) and playFlipSound (the
// original sharp snap, for cards being turned face-up) -- a deal and a
// reveal are physically different motions and shouldn't share a sound.
// (2) layered a second, detuned partial onto chipClack's existing tone,
// since a single pure partial still read a bit clean/synthetic even
// after the noise-based rework. See TableRoom.tsx for which cue fires
// where, and App.css's card-deal-land/card-deal-flip keyframes for the
// matching visual side of this same request (a card landing, then
// flipping, instead of just fading in).

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
// card snap. Frequency/duration jitter slightly per call so a run of
// several deals doesn't sound like one sample looping. `soft` dials it
// down into a landing TAP (quieter, lower, a touch longer) instead of a
// bright FLIP -- see playFlipSound/playDealSound below for which is which.
function cardSnap(audioCtx: AudioContext, at: number, soft = false): void {
  const duration = soft ? rand(0.05, 0.07) : rand(0.06, 0.09);
  const source = audioCtx.createBufferSource();
  source.buffer = noiseBuffer(audioCtx, duration);
  const filter = audioCtx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = soft ? rand(1500, 2100) : rand(2400, 3400);
  filter.Q.value = rand(0.8, 1.4);
  const gain = audioCtx.createGain();
  gain.gain.value = soft ? 0.08 : 0.16;
  source.connect(filter);
  filter.connect(gain);
  gain.connect(audioCtx.destination);
  const start = audioCtx.currentTime + at;
  source.start(start);
  source.stop(start + duration + 0.02);
}

// 2026-09-15: real request -- "les bruits de distribution et de
// retournement des cartes" should read as two distinct physical moments,
// not the same snap reused for both. A DEAL is a card sliding out across
// the felt to a seat (friction, not impact) ending in a soft landing tap;
// a FLIP/reveal is the sharp snap of a card being turned face-up (the
// original cardSnap on its own, renamed playFlipSound below). Splitting
// these also matches the visual split in App.css (card-deal-land vs
// card-deal-flip keyframes) -- sound and animation now agree on which
// moment is which.
function cardSlide(audioCtx: AudioContext, at: number): void {
  const duration = rand(0.1, 0.14);
  const source = audioCtx.createBufferSource();
  source.buffer = noiseBuffer(audioCtx, duration);
  const filter = audioCtx.createBiquadFilter();
  filter.type = "bandpass";
  filter.Q.value = 0.7;
  const start = audioCtx.currentTime + at;
  filter.frequency.setValueAtTime(rand(850, 1050), start);
  filter.frequency.exponentialRampToValueAtTime(rand(1700, 2100), start + duration);
  const gain = audioCtx.createGain();
  source.connect(filter);
  filter.connect(gain);
  gain.connect(audioCtx.destination);
  envelope(gain, audioCtx, at, 0.02, 0.07, duration);
  source.start(start);
  source.stop(start + duration + 0.02);
  cardSnap(audioCtx, at + duration * 0.8, true);
}

/** One or more cards being dealt out to a seat -- a felt slide, then a soft landing tap. */
export function playDealSound(count = 1): void {
  play((audioCtx) => {
    for (let i = 0; i < Math.min(count, 5); i++) cardSlide(audioCtx, i * 0.11 + rand(0, 0.015));
  });
}

/** One or more cards being turned face-up -- a crisp flip snap. */
export function playFlipSound(count = 1): void {
  play((audioCtx) => {
    for (let i = 0; i < Math.min(count, 5); i++) cardSnap(audioCtx, i * 0.065 + rand(0, 0.012));
  });
}

// A single chip knocking into a pile: a highpass-noise "tik" (the plastic/
// clay impact) plus a very short resonant ring on top (the faint ceramic
// ping real chips have) -- not a musical note, just enough tone to read as
// a solid object rather than a dry click.
//
// 2026-09-15: added a second, quieter partial at ~2.3x the base pitch,
// slightly detuned per call -- a real clay/ceramic chip's impact isn't a
// single clean tone, it's a couple of close, slightly-off overtones ringing
// together (what makes a real chip sound "chip-shaped" rather than like a
// block of wood). One partial alone read a little too pure/synth-like even
// after the 2026-09-12 noise-based pass; layering a second one is cheap
// (a few extra oscillator nodes) and reads noticeably more physical.
function chipClack(audioCtx: AudioContext, at: number, pitch = 1): void {
  const start = audioCtx.currentTime + at;

  const duration = rand(0.038, 0.052);
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

  const osc2 = audioCtx.createOscillator();
  const osc2Gain = audioCtx.createGain();
  osc2.type = "sine";
  osc2.frequency.value = rand(2.15, 2.45) * rand(1400, 1700) * pitch;
  osc2.connect(osc2Gain);
  osc2Gain.connect(audioCtx.destination);
  envelope(osc2Gain, audioCtx, at, 0.001, 0.018, 0.035);
  osc2.start(start);
  osc2.stop(start + 0.06);
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
