// Pen pressure curve, calibrated per device.
//
// Pens do not agree on what "normal" pressure is: the S Pen in Chrome on Android reports
// normal handwriting at about 0.05–0.3, in coarse 0.01 steps, while Windows pens sit around
// 0.3–0.7. Used raw, a light-reporting pen draws everything at the thin end of the range,
// and every 0.01 step is a visible jump in width (0.02 -> 0.03 is +50 %).
//
// So each device learns its typical writing pressure (`ref`, the running mean of the stroke
// medians) and pressures are mapped so that `ref` becomes 0.5, the middle of the width range:
//   p = 0.5 * (raw / ref) ^ 0.6, clamped to [MIN_P, 1]
// The raw value is smoothed first so the 0.01 steps do not show. The user can shift the
// curve with a sensitivity setting (-2..+2): more sensitivity = thicker for the same force.
import { tools } from './tools.js';

const GAMMA = 0.6;
const MIN_P = 0.12;           // never hair-thin, even when the tip barely touches
const SMOOTH = 0.35;          // weight of a new raw sample in the running average
const DEFAULT_REF = 0.5;      // before the first stroke: a pen that reports "normal" values
const MAX_N = 40;             // calibration memory (strokes)

/** Calibration state of this device: { ref, n }. */
export function calibration() {
  const c = tools.s.pressureCal;
  return c && c.ref > 0 ? c : { ref: DEFAULT_REF, n: 0 };
}

export function resetCalibration() {
  tools.set('pressureCal', { ref: DEFAULT_REF, n: 0 });
}

/** Effective reference including the user's sensitivity shift. */
function effectiveRef() {
  const sens = Number(tools.s.pressureSensitivity) || 0;
  return calibration().ref * 2 ** (-sens * 0.5);
}

/** Maps a (smoothed) raw pressure to 0..1. Exported for tests. */
export function mapPressure(raw, ref) {
  if (!(raw > 0)) return MIN_P;
  return Math.min(1, Math.max(MIN_P, 0.5 * (raw / ref) ** GAMMA));
}

/** One stroke: feed raw pressures in order, get mapped ones; end() updates the calibration. */
export class PressureTrack {
  #avg = null;
  #raw = [];
  #ref = effectiveRef();

  /** Smoothed raw pressure of the last sample. */
  get lastRaw() { return this.#avg ?? 0; }

  map(raw) {
    if (raw > 0) {
      this.#raw.push(raw);
      this.#avg = this.#avg == null ? raw : this.#avg + (raw - this.#avg) * SMOOTH;
    }
    return mapPressure(this.#avg ?? 0, this.#ref);
  }

  /** Raw pressure summary of the stroke, for the diagnostics log. */
  stats() {
    if (!this.#raw.length) return null;
    const s = [...this.#raw].sort((a, b) => a - b), r = (v) => Math.round(v * 1000) / 1000;
    return { min: r(s[0]), med: r(s[s.length >> 1]), max: r(s.at(-1)), ref: r(this.#ref) };
  }

  /**
   * Learns from the stroke (only real writing: enough samples). On a device that was not
   * calibrated yet it also returns a function (smoothed raw pressure -> mapped) with the curve
   * just learned, to redo this stroke's widths: even the very first stroke comes out right.
   */
  end() {
    if (this.#raw.length < 12) return null;
    const s = [...this.#raw].sort((a, b) => a - b);
    const med = s[s.length >> 1];
    if (!(med > 0.005) || med >= 0.999) return null;   // 1.0 = a device without real pressure
    const c = calibration();
    const n = Math.min(MAX_N, c.n);
    const ref = Math.min(0.8, Math.max(0.03, (c.ref * n + med) / (n + 1)));
    tools.setQuiet('pressureCal', { ref: Math.round(ref * 1000) / 1000, n: n + 1 });
    if (n > 0) return null;
    const newRef = effectiveRef();
    return (raw) => mapPressure(raw, newRef);
  }
}
