// Samsung Notes (.sdocx) reader, in the browser.
//
// A JavaScript port of the parts of the open-source Rust parser twangodev/sdocx (GPL-3.0)
// that Quadernone needs: pages (size, background colour, PDF template), handwriting strokes
// (points, pressure, time, colour, width, pen name), placed images, text boxes and the
// note's dates and body text. Verified against the Rust parser's JSON on real notes.
//
// An .sdocx is a zip (sometimes followed by an "end tag" record) with:
//   note.note        header (dates), title/body text, metadata (string table of pen names)
//   pageIdInfo.dat   page order
//   <uuid>.page      one page: header, properties, layers of objects
//   media/<id>@name  attachments (PDF, images); media/mediaInfo.dat maps ids to names
//   end_tag.bin      document record (display dates)
// All numbers are little-endian. Objects are "frames": size, kind, offsets and bit masks.

const END_TAG_SIGNATURE = 'Document for S-Pen SDK';
const TRAILER = 32;   // integrity hash after each object / layer / note

class SdocxError extends Error {}
const fail = (msg) => { throw new SdocxError(msg); };

/** Bounds-checked little-endian reader over a Uint8Array slice. */
class Reader {
  constructor(bytes, ctx = 'record', pos = 0) {
    this.b = bytes; this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = pos; this.ctx = ctx;
  }
  get remaining() { return this.b.length - this.pos; }
  need(n, what) { if (n < 0 || this.pos + n > this.b.length) fail(`${this.ctx}: ${what} troncato`); }
  u8(w = 'u8') { this.need(1, w); return this.b[this.pos++]; }
  u16(w = 'u16') { this.need(2, w); const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  i16(w = 'i16') { this.need(2, w); const v = this.dv.getInt16(this.pos, true); this.pos += 2; return v; }
  u32(w = 'u32') { this.need(4, w); const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  i32(w = 'i32') { this.need(4, w); const v = this.dv.getInt32(this.pos, true); this.pos += 4; return v; }
  i64(w = 'i64') { this.need(8, w); const v = Number(this.dv.getBigInt64(this.pos, true)); this.pos += 8; return v; }
  u64(w = 'u64') { this.need(8, w); const v = Number(this.dv.getBigUint64(this.pos, true)); this.pos += 8; return v; }
  f32(w = 'f32') { this.need(4, w); const v = this.dv.getFloat32(this.pos, true); this.pos += 4; return v; }
  f64(w = 'f64') { this.need(8, w); const v = this.dv.getFloat64(this.pos, true); this.pos += 8; return v; }
  bytes(n, w = 'bytes') { this.need(n, w); const v = this.b.subarray(this.pos, this.pos + n); this.pos += n; return v; }
  skip(n, w) { this.bytes(n, w); }
  utf16(units, w = 'text') { const raw = this.bytes(units * 2, w); return new TextDecoder('utf-16le').decode(raw); }
  /** u16 length (0xFFFF = null) + UTF-16. */
  str16(w) { const n = this.u16(w); return n === 0xffff ? null : this.utf16(n, w); }
  str32(w) { return this.utf16(this.u32(w), w); }
  utf8_16(w) { const n = this.u16(w); return new TextDecoder().decode(this.bytes(n, w)); }
}

/** Bit mask: u8 byte count + bytes. */
function readMask(r) {
  const bytes = r.bytes(r.u8('mask size'), 'mask');
  return {
    bytes,
    has: (bit) => ((bytes[bit >> 3] ?? 0) & (1 << (bit & 7))) !== 0,
    low: () => { let v = 0; for (let i = 0; i < Math.min(4, bytes.length); i++) v |= bytes[i] << (8 * i); return v >>> 0; },
    empty: () => bytes.every((x) => x === 0),
    count: bytes.length,
  };
}

/** A frame: u32 size, i16 kind, u32 flexible offset, properties mask, fields mask, fixed + flexible data. */
function readFrame(r, expectKind = null) {
  const size = r.u32('frame size');
  if (size < 12) fail(`frame non valido (${size})`);
  const data = r.bytes(size - 4, 'frame');
  const h = new Reader(data, 'frame header');
  const kind = h.i16('frame kind');
  const flexOff = h.u32('flexible offset');
  const properties = readMask(h);
  const fields = readMask(h);
  const fixedEnd = flexOff === 0 && fields.empty() ? size : flexOff;
  if (fixedEnd < h.pos + 4 || fixedEnd > size) fail(`frame ${kind}: offset non valido`);
  if (expectKind !== null && kind !== expectKind) fail(`frame atteso ${expectKind}, trovato ${kind}`);
  return { kind, properties, fields, fixed: data.subarray(h.pos, fixedEnd - 4), flexible: data.subarray(fixedEnd - 4) };
}

const readBBox = (r) => ({ x_min: r.f64('left'), y_min: r.f64('top'), x_max: r.f64('right'), y_max: r.f64('bottom') });

/** Common object header (frame kind 0). */
function readObjectBase(r) {
  const f = readFrame(r, 0);
  const fx = new Reader(f.fixed, 'object base');
  fx.u32('format'); fx.utf8_16('uuid'); fx.i64('modified');
  const bbox = readBBox(fx);
  const fl = new Reader(f.flexible, 'object base flexible');
  const rotation = f.fields.has(0) ? fl.f32('rotation') : null;
  return { bbox, rotation, visible: f.properties.has(3), fieldMask: f.fields.bytes, flexibleRest: f.flexible.subarray(fl.pos) };
}

// ------------------------------------------------------------------ strokes

function signedDelta(raw, div) { const m = (raw & 0x7fff) / div; return raw & 0x8000 ? -m : m; }

function floatChannel(r, count, compressed) {
  const out = [];
  if (!count) return out;
  let v = r.f32('channel');
  out.push(v);
  for (let i = 1; i < count; i++) { v = compressed ? v + signedDelta(r.u16('channel delta'), 4096) : r.f32('channel'); out.push(v); }
  return out;
}

function decodeStroke(payload) {
  const frames = new Reader(payload, 'stroke');
  const base = readObjectBase(frames);
  const f = readFrame(frames, 1);
  const fx = new Reader(f.fixed, 'stroke channels');
  const count = fx.u16('point count');
  const compressed = f.properties.has(0), stylus = f.properties.has(2);
  const channelBytes = !count ? 0 : compressed
    ? 16 + (count - 1) * 4 + (2 + (stylus ? 2 : 0)) * (4 + (count - 1) * 2)
    : count * (24 + (stylus ? 8 : 0));
  if (fx.remaining !== channelBytes + 2) fail('canali del tratto inattesi');
  const ch = new Reader(fx.bytes(channelBytes, 'channels'), 'stroke channels');
  const xs = new Float64Array(count), ys = new Float64Array(count);
  if (count && compressed) {
    let x = ch.f64('x'), y = ch.f64('y');
    xs[0] = x; ys[0] = y;
    for (let i = 1; i < count; i++) { x += signedDelta(ch.u16('dx'), 32); y += signedDelta(ch.u16('dy'), 32); xs[i] = x; ys[i] = y; }
  } else {
    for (let i = 0; i < count; i++) { xs[i] = ch.f64('x'); ys[i] = ch.f64('y'); }
  }
  const pressures = floatChannel(ch, count, compressed);
  const timestamps = [];
  if (count) {
    let t = ch.i32('t0');
    timestamps.push(t);
    for (let i = 1; i < count; i++) { t = compressed ? t + ch.u16('dt') : ch.i32('t'); timestamps.push(t); }
  }
  // Style (flexible fields 0–3 and 7 matter: pen name ids, colour, size).
  const st = new Reader(f.flexible, 'stroke style');
  const style = {};
  if (f.fields.has(0)) style.legacyPenNameId = st.i32();
  if (f.fields.has(1)) style.settingsId = st.i32();
  if (f.fields.has(2)) style.argb = st.u32();
  if (f.fields.has(3)) style.penSize = st.f32();
  for (let bit = 4; bit < f.fields.count * 8; bit++) {
    if (!f.fields.has(bit)) continue;
    let done = false;
    switch (bit) {
      case 4: st.u8(); break;
      case 5: {
        let n = 0;
        if (base.fieldMask[0] & 2) { const pr = new Reader(base.flexibleRest, 'partial rects'); n = pr.u16(); }
        st.skip(n * 4, 'partial rects'); break;
      }
      case 7: style.penNameId = st.i32(); break;
      case 8: case 13: case 15: case 17: case 18: case 20: case 23: st.f32(); break;
      case 9: case 10: case 11: case 12: case 19: case 21: case 22: st.i32(); break;
      case 14: case 16: case 25: st.u16(); break;
      case 24: { const n = st.u16(); st.skip(n * 4); break; }
      default: done = true;
    }
    if (done) break;
  }
  return {
    type: 'stroke', visible: base.visible, bbox: base.bbox,
    xs, ys, pressures, timestamps,
    argb: style.argb ?? 0xff000000,
    penWidth: style.penSize ?? 0.8,
    penNameId: style.penNameId != null && style.penNameId !== -1 ? style.penNameId : style.legacyPenNameId ?? null,
    eraser: f.properties.has(3),
  };
}

// ------------------------------------------------------------------ images and text

function decodeImage(payload) {
  const r = new Reader(payload, 'image');
  const base = readObjectBase(r);
  readFrame(r, 6);
  const shape = readFrame(r, 7);
  let mediaId = null;
  const fl = new Reader(shape.flexible, 'image shape fields');
  if (shape.fields.has(0)) fl.skip(fl.u32(), 'text');
  if (shape.fields.has(1)) fl.u8();
  if (shape.fields.has(2)) fl.i32();
  if (!shape.fields.has(3)) {
    if (shape.fields.has(4)) fl.i32();
    if (shape.fields.has(5)) {
      const size = fl.u32(), kind = fl.u8(), fill = fl.bytes(size);
      if (kind === 2 && fill.length <= 62) {
        const fr = new Reader(fill, 'image fill');
        fr.u8(); const id = fr.i32();
        if (id >= 0) mediaId = id;
      }
    }
  }
  return { type: 'image', visible: base.visible, bbox: base.bbox, rotation: base.rotation, mediaId };
}

/** Plain text of a rich-text object (object base, frame 6, frame 7 with the "text common"). */
function readRichText(r) {
  const base = readObjectBase(r);
  readFrame(r, 6);
  const st = readFrame(r, 7);
  let text = '';
  if (st.fields.has(0)) {
    const fl = new Reader(st.flexible, 'text');
    const common = new Reader(fl.bytes(fl.u32('text common size')), 'text common');
    text = common.str32('text');
  }
  return { base, text };
}

function decodeTextBox(payload) {
  const { base, text } = readRichText(new Reader(payload, 'text box'));
  return { type: 'text', visible: base.visible, bbox: base.bbox, rotation: base.rotation, text };
}

// ------------------------------------------------------------------ pages

function parseObjects(r, depth = 0) {
  if (depth > 32) fail('oggetti annidati troppo in profondità');
  const type = r.u8('object type');
  const childCount = r.u16('children');
  const size = r.u32('object size');
  if (size < TRAILER) fail('oggetto troppo piccolo');
  const payload = r.bytes(size - TRAILER, 'object payload');
  r.skip(TRAILER, 'object hash');
  const children = [];
  for (let i = 0; i < childCount; i++) children.push(parseObjects(r, depth + 1));
  return { type, payload, children };
}

function parsePage(data) {
  const r = new Reader(data, 'page');
  const layerOffset = r.u32('layer offset');
  const propOffset = r.u32('property offset');
  const headerEnd = propOffset === 0 ? layerOffset : propOffset;
  if (headerEnd > layerOffset || layerOffset > data.length) fail('intestazione di pagina non valida');
  const h = new Reader(data.subarray(0, headerEnd), 'page header', r.pos);
  readMask(h);
  const fields = readMask(h);
  const propertyMask = fields.low();
  h.u32('orientation');
  const width = h.u32('width'), height = h.u32('height');
  h.u32(); h.u32();
  const uuid = h.str16('uuid');
  if (h.pos + 8 <= headerEnd) h.u64();
  const formatVersion = h.pos + 4 <= headerEnd ? h.u32() : null;

  const page = { uuid, width, height, backgroundArgb: null, templateId: null, pdfPageIndex: null, objects: [] };
  if (propOffset !== 0) {
    const p = new Reader(data.subarray(propOffset, layerOffset), 'page properties');
    for (let bit = 0; bit <= 9; bit++) {
      if (!(propertyMask & (1 << bit))) continue;
      switch (bit) {
        case 0: readBBox(p); break;
        case 1: { const n = p.u16(); for (let i = 0; i < n; i++) p.str16('tag'); break; }
        case 2: p.str16('template uri'); break;
        case 3: case 4: case 6: case 7: p.u32(); break;
        case 5: page.backgroundArgb = p.u32(); break;
        case 8: {
          const n = p.u16();
          const recs = new Reader(p.bytes(n * 24), 'pdf records');
          for (let i = 0; i < n; i++) { recs.i32(); const idx = recs.i32(); recs.skip(16); if (i === 0) page.pdfPageIndex = idx; }
          break;
        }
        case 9: page.templateId = p.u32(); break;
        default: break;
      }
    }
  }
  void formatVersion;

  // Layers: decode the current one (as the reference parser does).
  const lr = new Reader(data, 'layers', layerOffset);
  const layerCount = lr.u16('layer count');
  const current = lr.u16('current layer');
  if (!layerCount || current >= layerCount) fail('livelli di pagina non validi');
  for (let li = 0; li < layerCount; li++) {
    const headerSize = lr.u32('layer header size');
    if (headerSize < 14 || headerSize > 16384) fail('intestazione di livello non valida');
    lr.skip(headerSize - 4, 'layer header');
    const n = lr.u32('object count');
    const objs = [];
    for (let i = 0; i < n; i++) objs.push(parseObjects(lr));
    lr.skip(TRAILER, 'layer hash');
    if (li === current) page.objects = flatten(objs);
  }
  return page;
}

/** Decoded objects in drawing order; groups are flattened; hidden objects are skipped. */
function flatten(stored, out = []) {
  for (const o of stored) {
    let d = null;
    try {
      if (o.type === 1) d = decodeStroke(o.payload);
      else if (o.type === 3) d = decodeImage(o.payload);
      else if (o.type === 2) d = decodeTextBox(o.payload);
    } catch (e) {
      if (!(e instanceof SdocxError)) throw e;
      d = null;   // one unreadable object does not lose the page
    }
    if (d && d.visible) out.push(d);
    flatten(o.children, out);
  }
  return out;
}

// ------------------------------------------------------------------ note.note, end tag, media

function parseNote(data) {
  const r = new Reader(data, 'note');
  const flexOff = r.u32('flexible offset');
  if (flexOff < r.pos || flexOff > data.length) fail('note.note non valido');
  const h = new Reader(data.subarray(0, flexOff), 'note header', r.pos);
  readMask(h);
  const fields = readMask(h);
  h.u32('format');
  h.str16('note id');
  h.u32('revision');
  const createdMs = h.i64('created'), modifiedMs = h.i64('modified');
  h.u32(); h.u32(); h.u32(); h.u32(); h.u32();
  h.skip(h.u32('title size'), 'title');
  let bodyText = '';
  const body = h.bytes(h.u32('body size'), 'body');
  try { bodyText = readRichText(new Reader(body, 'body')).text; } catch { bodyText = ''; }
  const fixedEnd = h.pos;

  // Metadata (flexible part): only the string table (pen names) is needed.
  const strings = new Map();
  const payloadEnd = data.length - TRAILER;
  if (flexOff >= fixedEnd && flexOff <= payloadEnd) {
    const m = new Reader(data.subarray(flexOff, payloadEnd), 'note metadata');
    try {
      for (let bit = 0; bit < fields.count * 8; bit++) {
        if (!fields.has(bit)) continue;
        if (bit === 0) m.str16('app');
        else if (bit === 1) { m.i32(); m.i32(); m.str16('patch'); }
        else if (bit === 2) { m.str16(); m.str16(); m.str16(); m.u32(); }
        else if (bit === 3) { m.f64(); m.f64(); }
        else if (bit === 6) m.str16('template');
        else if (bit === 7) m.i32();
        else if (bit === 9) { m.u32(); m.i64(); }
        else if (bit === 10) {
          const t = new Reader(m.bytes(m.u32('string table size')), 'string table');
          const n = t.u16();
          for (let i = 0; i < n; i++) { const id = t.u32(); strings.set(id, t.str16('string')); }
          break;
        } else break;   // unknown field before the string table
      }
    } catch { /* pen names stay unknown: strokes become ballpoints */ }
  }
  return { createdMs, modifiedMs, bodyText, strings };
}

function parseEndTag(bytes) {
  const r = new Reader(bytes, 'end tag');
  const size = r.u16();
  if (size !== r.remaining) return null;
  const sig = new TextDecoder().decode(bytes.subarray(bytes.length - END_TAG_SIGNATURE.length));
  if (sig !== END_TAG_SIGNATURE) return null;
  const f = new Reader(bytes.subarray(2, bytes.length - END_TAG_SIGNATURE.length), 'end tag');
  const version = f.u32();
  if (version < 2034) return null;
  f.str16(); const modified = f.i64(); f.u32(); f.str16(); f.u32(); f.f32(); f.str16(); f.i32(); f.i32(); f.str16(); f.u32();
  const created = f.i64(); f.i32(); f.u16();
  const tag = { created, modified };
  try {
    if (f.remaining) f.u16();                         // document type
    if (f.remaining) f.str16();                       // owner
    if (f.remaining) f.skip(f.u32());                 // reserved
    if (f.remaining) { const n = f.u32(); if (n) tag.encrypted = true; f.skip(n); }
    if (f.remaining) { tag.created = f.i64(); tag.modified = f.i64(); }   // display dates
  } catch { /* older records */ }
  return tag;
}

/** Splits a trailing end tag off the zip (as the reference parser's ArchiveTail). */
function splitTail(buf) {
  const MAX = 22 + 0xffff + 2 + 0xffff;
  const start = Math.max(0, buf.length - MAX);
  for (let off = start; off <= buf.length - 22; off++) {
    if (buf[off] !== 0x50 || buf[off + 1] !== 0x4b || buf[off + 2] !== 5 || buf[off + 3] !== 6) continue;
    const dv = new DataView(buf.buffer, buf.byteOffset + off, 22);
    if (dv.getUint32(4, true) !== 0 || dv.getUint16(8, true) !== dv.getUint16(10, true)) continue;
    const tagStart = off + 22 + dv.getUint16(20, true);
    if (tagStart >= buf.length) return { zip: buf, tag: null };
    const tag = buf.subarray(tagStart);
    if (tag.length < 2 + END_TAG_SIGNATURE.length) continue;
    return { zip: buf.subarray(0, tagStart), tag };
  }
  return { zip: buf, tag: null };
}

function parseMediaManifest(data) {
  const map = new Map();
  const r = new Reader(data, 'media manifest');
  if (r.u32() <= 3001) return map;
  const n = r.u16();
  for (let i = 0; i < n; i++) {
    const rec = new Reader(r.bytes(r.u32()), 'media record');
    map.set(rec.u32(), rec.str16('file'));
  }
  return map;
}

// ------------------------------------------------------------------ public

/**
 * Reads an .sdocx. Returns:
 * { createdMs, modifiedMs, bodyText,
 *   pages: [{ uuid, width, height, backgroundArgb, templateId, pdfPageIndex,
 *             objects: [stroke | image | text] }],   // Samsung units (page width 1440)
 *   media: Map(id -> { name, blob() }) }
 * stroke: { xs, ys, pressures, timestamps, argb, penWidth, penName, eraser }
 */
export async function readSdocx(file, JSZip) {
  const buf = new Uint8Array(await file.arrayBuffer());
  if (!buf.length || buf.every((b) => b === 0)) throw new SdocxError('file vuoto o danneggiato');
  const { zip: zipBytes, tag: appended } = splitTail(buf);
  let zip;
  try { zip = await JSZip.loadAsync(zipBytes); } catch { throw new SdocxError('non è un file Samsung Notes valido (archivio danneggiato)'); }
  const entry = (name) => zip.file(name);
  const bytesOf = async (name) => { const e = entry(name); return e ? new Uint8Array(await e.async('uint8array')) : null; };

  let tag = appended ? parseEndTag(appended) : null;
  if (!tag) { const b = await bytesOf('end_tag.bin'); if (b) tag = parseEndTag(b); }
  if (tag?.encrypted) throw new SdocxError('nota protetta da password: sbloccala in Samsung Notes prima di esportarla');

  const noteBytes = await bytesOf('note.note');
  const note = noteBytes ? parseNote(noteBytes) : { createdMs: null, modifiedMs: null, bodyText: '', strings: new Map() };

  let order = [];
  const manifest = await bytesOf('pageIdInfo.dat');
  if (manifest) {
    const r = new Reader(manifest, 'page manifest');
    r.skip(TRAILER);
    const n = r.u16();
    for (let i = 0; i < n; i++) { order.push(r.str16('page id')); r.skip(TRAILER); }
  }

  const names = Object.keys(zip.files).filter((n) => n.endsWith('.page')).sort();
  if (!names.length) throw new SdocxError('nessuna pagina nel file');
  const pages = [];
  for (const name of names) {
    const page = parsePage(await bytesOf(name));
    for (const o of page.objects) if (o.type === 'stroke') o.penName = o.penNameId != null ? note.strings.get(o.penNameId >>> 0) ?? null : null;
    pages.push(page);
  }
  const rank = new Map(order.map((id, i) => [id, i]));
  pages.sort((a, b) => (rank.get(a.uuid) ?? 1e9) - (rank.get(b.uuid) ?? 1e9));

  const media = new Map();
  const info = await bytesOf('media/mediaInfo.dat');
  let manifestNames = new Map();
  if (info) { try { manifestNames = parseMediaManifest(info); } catch { /* fall back to file names */ } }
  zip.forEach((path, e) => {
    const m = /^media\/(\d+)@(.+)$/.exec(path);
    if (!m || e.dir || /\.spi$/i.test(path)) return;
    const id = Number(m[1]);
    media.set(id, { name: m[2], blob: () => e.async('blob') });
  });
  for (const [id, fileName] of manifestNames) {
    if (media.has(id) || /\.spi$/i.test(fileName)) continue;
    const e = entry('media/' + fileName);
    if (e) media.set(id, { name: fileName.replace(/^\d+@/, ''), blob: () => e.async('blob') });
  }

  return {
    createdMs: tag?.created ?? note.createdMs,
    modifiedMs: tag?.modified ?? note.modifiedMs,
    bodyText: note.bodyText,
    pages,
    media,
  };
}

export { SdocxError };
