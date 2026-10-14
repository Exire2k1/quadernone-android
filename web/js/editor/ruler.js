// Virtual ruler: lies over the page; move it with one finger, rotate it with two.
// A pen stroke that starts near one of its long edges is drawn straight along that edge.
const THICK = 76;          // px
const SNAP_PX = 18;        // a stroke starting this close to an edge snaps to it

export class Ruler {
  visible = false;
  cx = 0; cy = 0; angle = 0;   // stage px, radians (angle is snapped; raw follows the fingers)
  #raw = 0;
  #touch = new Map();
  #start = null;

  constructor(stage, view) {
    this.stage = stage;
    this.view = view;
    this.el = document.createElement('div');
    this.el.className = 'ruler';
    this.el.hidden = true;
    this.label = document.createElement('div');
    this.label.className = 'ruler-angle';
    this.el.append(this.label);
    stage.append(this.el);
    view.addEventListener('zoom', () => this.render());
  }

  get length() { return Math.min(this.stage.clientWidth * 0.85, 900); }

  toggle(on = !this.visible) {
    this.visible = on;
    if (on && !this.cx) { this.cx = this.stage.clientWidth / 2; this.cy = this.stage.clientHeight / 2; }
    this.el.hidden = !on;
    this.render();
  }

  render() {
    if (!this.visible) return;
    const L = this.length;
    const s = this.view.s;   // px per mm: ticks match the page scale
    this.el.style.width = L + 'px';
    this.el.style.height = THICK + 'px';
    this.el.style.transform = `translate(${this.cx - L / 2}px, ${this.cy - THICK / 2}px) rotate(${this.angle}rad)`;
    this.el.style.setProperty('--mm', s + 'px');
    const deg = ((Math.round(this.angle * 180 / Math.PI) % 360) + 360) % 360;
    this.label.textContent = `${deg > 180 ? deg - 360 : deg}°`;
  }

  /** Local coordinates of a stage point (u along the ruler, v across it). */
  #local(x, y) {
    const dx = x - this.cx, dy = y - this.cy, c = Math.cos(this.angle), s = Math.sin(this.angle);
    return { u: dx * c + dy * s, v: -dx * s + dy * c };
  }

  hit(x, y) {
    if (!this.visible) return false;
    const { u, v } = this.#local(x, y);
    return Math.abs(u) <= this.length / 2 && Math.abs(v) <= THICK / 2;
  }

  /** The edge a stroke starting at (x, y) should follow, or null. */
  edgeNear(x, y) {
    if (!this.visible) return null;
    const { u, v } = this.#local(x, y);
    if (Math.abs(u) > this.length / 2 + 40) return null;
    for (const side of [-1, 1]) {
      if (Math.abs(v - side * THICK / 2) <= SNAP_PX) return side;
    }
    return null;
  }

  /** Projects a stage point onto an edge (side -1 = top, 1 = bottom). */
  project(x, y, side) {
    const { u } = this.#local(x, y);
    const v = side * THICK / 2;
    const c = Math.cos(this.angle), s = Math.sin(this.angle);
    return { x: this.cx + u * c - v * s, y: this.cy + u * s + v * c };
  }

  // ---- touch gestures (forwarded by the editor's input handler)
  down(e) {
    this.#touch.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.#start = this.#snapshot();
  }

  move(e) {
    if (!this.#touch.has(e.pointerId)) return false;
    this.#touch.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const now = this.#snapshot();
    const st = this.#start;
    this.cx += now.mx - st.mx;
    this.cy += now.my - st.my;
    if (now.n >= 2 && st.n >= 2) this.#raw += now.ang - st.ang;
    // Snaps to horizontal/vertical within 2°.
    const q = Math.PI / 2, r = Math.round(this.#raw / q) * q;
    this.angle = Math.abs(this.#raw - r) < 0.035 ? r : this.#raw;
    this.#start = now;
    this.render();
    return true;
  }

  up(e) {
    if (!this.#touch.delete(e.pointerId)) return false;
    this.#start = this.#snapshot();
    return true;
  }

  owns(pointerId) { return this.#touch.has(pointerId); }

  #snapshot() {
    const pts = [...this.#touch.values()];
    const r = this.stage.getBoundingClientRect();
    const n = pts.length;
    const mx = pts.reduce((a, p) => a + p.x, 0) / (n || 1) - r.left;
    const my = pts.reduce((a, p) => a + p.y, 0) / (n || 1) - r.top;
    const ang = n >= 2 ? Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x) : 0;
    return { n, mx, my, ang };
  }
}
