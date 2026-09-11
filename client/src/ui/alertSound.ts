/**
 * Alert chime (campaign-4 contract P3, lane C1) — a short two-tone beep when a
 * fired alert batch lands, so alerts work when the user looks away.
 *
 * Deliberate constraints:
 *   - LAZY AudioContext: created on the first beep, never at import time (a
 *     module-level context would hold an audio thread open on boot).
 *   - Autoplay policy: if the context starts/became `suspended`, resume() is
 *     attempted and a one-shot pointerdown/keydown listener re-resumes on the
 *     first user gesture (the only moment browsers allow audio).
 *   - Burst rate-limit: at most one beep per {@link BEEP_MIN_GAP_MS}. Callers
 *     already coalesce a batch into one call; this guards rapid successive
 *     batches (e.g. several symbols firing within the same second).
 *   - Best-effort: a missing/blocked AudioContext is silence, never an error
 *     into the evaluation path.
 *
 * The `alertSound` setting (ui/settings.ts) gates the CALL from PriceAlerts.
 */

/** Minimum spacing between beeps (ms). One beep per burst. */
export const BEEP_MIN_GAP_MS = 150;

/** Two-tone chime: [frequency Hz, start offset s, duration s]. */
const TONES: ReadonlyArray<readonly [number, number, number]> = [
  [880, 0, 0.07],
  [1318.5, 0.08, 0.09],
];

/** Gain envelope peak — quiet, informative, not a fire alarm. */
const PEAK_GAIN = 0.07;

type AudioContextCtor = new () => AudioContext;

let ctx: AudioContext | null = null;
let lastBeepAt = Number.NEGATIVE_INFINITY;
let gestureArmed = false;

function audioCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

function context(): AudioContext | null {
  if (ctx !== null) return ctx;
  const Ctor = audioCtor();
  if (Ctor === null) return null;
  try {
    ctx = new Ctor();
  } catch {
    ctx = null; // construction denied — permanent silence, never a crash
  }
  return ctx;
}

function tryResume(audio: AudioContext): void {
  try {
    const p = audio.resume?.();
    if (p !== undefined && typeof p.catch === 'function') void p.catch(() => {});
  } catch {
    /* resume is best-effort */
  }
}

/** Arm a one-shot gesture listener that resumes the suspended context. */
function armGestureResume(): void {
  if (gestureArmed || typeof window === 'undefined') return;
  gestureArmed = true;
  const onGesture = (): void => {
    window.removeEventListener('pointerdown', onGesture, true);
    window.removeEventListener('keydown', onGesture, true);
    gestureArmed = false;
    if (ctx !== null) tryResume(ctx);
  };
  window.addEventListener('pointerdown', onGesture, true);
  window.addEventListener('keydown', onGesture, true);
}

function scheduleTone(audio: AudioContext, freq: number, offsetS: number, durS: number): void {
  const t0 = audio.currentTime + 0.001 + offsetS;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(freq, t0);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(PEAK_GAIN, t0 + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durS);
  osc.connect(gain);
  gain.connect(audio.destination);
  osc.start(t0);
  osc.stop(t0 + durS + 0.02);
}

/**
 * Play the alert chime. Rate-limited: returns false (and stays silent) when the
 * previous beep is younger than {@link BEEP_MIN_GAP_MS}. Returns true when a
 * chime was actually scheduled.
 */
export function playAlertSound(now = Date.now()): boolean {
  if (now - lastBeepAt < BEEP_MIN_GAP_MS) return false;
  const audio = context();
  if (audio === null) return false;
  lastBeepAt = now;
  if (audio.state === 'suspended') {
    tryResume(audio);
    armGestureResume();
  }
  for (const [freq, offset, dur] of TONES) scheduleTone(audio, freq, offset, dur);
  return true;
}

/** Test seam: forget the context, the rate-limit clock and the gesture arming. */
export function resetAlertSoundForTest(): void {
  ctx = null;
  lastBeepAt = Number.NEGATIVE_INFINITY;
  gestureArmed = false;
}
