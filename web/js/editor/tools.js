// Drawing tool settings, remembered per device.
import * as prefs from '../prefs.js';
import { PT_TO_MM } from '../page/ink.js';

export const DRAW_TOOLS = ['pen', 'highlighter', 'eraser', 'lasso', 'shape'];
export const HIGHLIGHTER_COLORS = ['#FFE34D', '#8CF56E', '#5CE1FF', '#FF85DD', '#FFAE57', '#C19BFF'];
export const QUICK_COLORS = ['#1A1A1A', '#5A5F66', '#C62828', '#E65100', '#F9A825', '#2E7D32', '#00838F', '#1565C0', '#6A1B9A', '#FFFFFF'];

const DEFAULTS = {
  active: 'pen',
  previous: 'pen',                 // tool to go back to after a side-button toggle
  pen: { type: 'fountain', widthPt: 1.6, color: '#1A1A1A', favorites: [0.8, 1.6, 3.2], pressure: true },
  highlighter: { widthPt: 14, color: '#FFE34D', tip: 'round', straight: false },
  eraser: { mode: 'area', sizeMm: 4 },   // area = erases only where it passes
  lasso: { mode: 'free', filter: 'all' },
  shape: { mode: 'auto', widthPt: 1.6, color: '#1A1A1A', fill: null },
  quickColors: QUICK_COLORS,
  recentColors: [],
  fingerMode: 'pen',               // 'pen' = Solo penna, 'both' = Dito e penna
  sideButton: true,
  holdMs: 300,
  penShapes: true,                 // pen held still at the end of a stroke -> perfect shape
  pressureSensitivity: 0,          // -2..+2: shifts the pressure curve (see pressure.js)
  pressureCal: null,               // { ref, n }: typical pressure of this device's pen, learned
  v: 2,                            // settings version (migrations below)
};

function load() {
  const saved = prefs.get('tools') || {};
  const out = structuredClone(DEFAULTS);
  for (const [k, v] of Object.entries(saved)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...out[k], ...v } : v;
  }
  // v2: the eraser erases only where it passes by default (whole strokes stays an option).
  if ((saved.v || 1) < 2) { out.eraser.mode = 'area'; out.v = 2; }
  return out;
}

class Tools extends EventTarget {
  s = load();

  get active() { return this.s.active; }
  isDrawing(t = this.s.active) { return DRAW_TOOLS.includes(t); }

  setActive(tool) {
    if (tool === this.s.active) return;
    if (tool !== 'eraser' && tool !== 'lasso') this.s.previous = tool;
    this.s.active = tool;
    this.#save();
  }

  /** Side-button short press: pen ⇄ eraser (back to the exact previous tool). */
  togglePenEraser() {
    if (this.s.active === 'eraser') this.s.active = this.s.previous || 'pen';
    else { this.s.previous = this.s.active === 'lasso' ? this.s.previous : this.s.active; this.s.active = 'eraser'; }
    this.#save();
  }

  update(tool, patch) {
    this.s[tool] = { ...this.s[tool], ...patch };
    this.#save();
  }

  set(key, value) {
    this.s[key] = value;
    this.#save();
  }

  /** Colour of the active colour-bearing tool. */
  get color() {
    const t = this.s.active === 'highlighter' ? 'highlighter' : this.s.active === 'shape' ? 'shape' : 'pen';
    return this.s[t].color;
  }

  setColor(c) {
    const t = this.s.active === 'highlighter' ? 'highlighter' : this.s.active === 'shape' ? 'shape' : 'pen';
    this.s[t] = { ...this.s[t], color: c };
    this.s.recentColors = [c, ...this.s.recentColors.filter((x) => x !== c)].slice(0, 5);
    this.#save();
  }

  /** Stroke template for the pen or highlighter. */
  strokeStyle(tool) {
    if (tool === 'highlighter') {
      const h = this.s.highlighter;
      return { tool: 'highlighter', color: h.color, width: h.widthPt * PT_TO_MM, opacity: 0.35, tip: h.tip };
    }
    if (tool === 'shape') {
      return { tool: 'ballpoint', color: this.s.shape.color, width: this.s.shape.widthPt * PT_TO_MM, opacity: 1, pressure: false };
    }
    const p = this.s.pen;
    return {
      tool: p.type, color: p.color, width: p.widthPt * PT_TO_MM, opacity: p.type === 'pencil' ? 0.9 : 1,
      ...(p.pressure ? {} : { pressure: false }),
    };
  }

  /** Stores a setting the toolbar does not show (no 'change' event, so no re-render). */
  setQuiet(key, value) {
    this.s[key] = value;
    prefs.set('tools', this.s);
  }

  #save() {
    prefs.set('tools', this.s);
    this.dispatchEvent(new Event('change'));
  }
}

export const tools = new Tools();
