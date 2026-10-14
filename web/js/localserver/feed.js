// Change feed (port of Feed.php, kept in memory).
//
// On the old server the feed told other devices what changed. In the app the only
// writer is the app itself, so the feed lives in memory: after a restart it starts again
// from 0 and a client asking for an older position simply gets {reset: true} and reloads.
import { now } from './util.js';

const KEEP = 2000;
/** More changes than this in one poll: the client reloads the tree instead. */
const MAX_RETURN = 2000;

export class Feed {
  #lines = [];
  #seq = 0;

  append(c, device) {
    const line = {
      seq: ++this.#seq,
      time: now(),
      type: c.type,
      kind: c.kind,
      id: c.id ?? null,
      parentId: c.parentId ?? null,
      revision: c.revision ?? null,
      pageId: c.pageId ?? null,
      device,
      ...(c.extra || {}),
    };
    this.#lines.push(line);
    if (this.#lines.length > KEEP * 2) this.#lines.splice(0, this.#lines.length - KEEP);
    return line.seq;
  }

  currentSeq() { return this.#seq; }

  since(since) {
    const current = this.#seq;
    if (since === current) return { changes: [], seq: current };
    if (since > current || since < 0) return { reset: true, seq: current };
    const first = this.#lines[0]?.seq ?? current + 1;
    if (first > since + 1) return { reset: true, seq: current };
    const out = this.#lines.filter((l) => l.seq > since);
    if (out.length > MAX_RETURN) return { reset: true, seq: current };
    return { changes: out, seq: current };
  }
}
