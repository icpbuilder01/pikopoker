// Short UI sound effects, synthesized live via the Web Audio API instead of
// shipped as audio files -- keeps the bundle light and sidesteps sourcing/
// licensing real samples for a handful of one-off cues. Every call is
// wrapped so a failure (no AudioContext, autoplay policy, muted) is a
// silent no-op -- sound is decoration, never allowed to break gameplay.

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

function envelope(gain: GainNode, audioCtx: AudioContext, at: number, attack: number, peak: number, release: number): void {
  const start = audioCtx.currentTime + at;
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(peak, start + attack);
  gain.gain.exponentialRampToValueAtTime(0.001, start + attack + release);
}

function tone(audioCtx: AudioContext, freq: number, at: number, duration: number, type: OscillatorType, peak: number): void {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  envelope(gain, audioCtx, at, 0.004, peak, duration);
  const start = audioCtx.currentTime + at;
  osc.start(start);
  osc.stop(start + duration + 0.05);
}

// A quick decaying burst of filtered noise -- reads as a crisp card slide/
// flip rather than a musical tone.
function cardSnap(audioCtx: AudioContext, at: number): void {
  const duration = 0.08;
  const size = Math.max(1, Math.floor(audioCtx.sampleRate * duration));
  const buffer = audioCtx.createBuffer(1, size, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < size; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / size);
  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  const filter = audioCtx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = 2800;
  filter.Q.value = 1;
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
    for (let i = 0; i < Math.min(count, 5); i++) cardSnap(audioCtx, i * 0.065);
  });
}

/** A bet, call, or raise landing -- a couple of quick chip clicks. */
export function playChipSound(): void {
  play((audioCtx) => {
    tone(audioCtx, 1900, 0, 0.05, "square", 0.05);
    tone(audioCtx, 2300, 0.035, 0.05, "square", 0.04);
  });
}

/** Folding -- a soft, short descending thud, nothing dramatic. */
export function playFoldSound(): void {
  play((audioCtx) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(220, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(90, audioCtx.currentTime + 0.16);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    envelope(gain, audioCtx, 0, 0.004, 0.1, 0.16);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.25);
  });
}

/** Winning a hand -- a bright ascending three-note chime. */
export function playWinSound(): void {
  play((audioCtx) => {
    const notes = [523.25, 659.25, 783.99]; // C5, E5, G5
    notes.forEach((freq, i) => tone(audioCtx, freq, i * 0.09, 0.22, "triangle", 0.13));
  });
}
