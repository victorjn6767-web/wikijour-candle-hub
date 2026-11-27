'use strict';
// Reader side (app / Worker). Trusts nothing but the pinned public key(s): signature, SHA-256, size limits, structure, row sanity.
const zlib = require('zlib');
const { LIM, monthPath, parse } = require('./manifest');
const { verify, sha256 } = require('./sign');
const { decode } = require('../wjm1');
const EPOCH = 946684800;
class HubReader {
  // o: { read(path)->Buffer|null (bucket hub only), trusted:{keyId:pem}, lastSeq?, maxAgeSec?, now? }
  constructor(o) { this.read = o.read; this.trusted = o.trusted; this.lastSeq = o.lastSeq || 0; this.maxAge = o.maxAgeSec; this.now = o.now || (() => Date.now()); this.m = null; }
  async manifest() {
    const mb = await this.read('manifest.json'), sb = await this.read('manifest.sig');
    if (!mb || !sb) throw new Error('manifest or signature missing');
    if (mb.length > LIM.manifest) throw new Error('manifest too large');
    verify(mb, sb, this.trusted);                       // signature first: nothing is parsed from unsigned bytes
    const m = parse(mb);
    if (m.seq < this.lastSeq) throw new Error(`manifest rollback rejected (seq ${m.seq} < ${this.lastSeq})`);
    if (this.maxAge != null && this.now() - Date.parse(m.generated) > this.maxAge * 1000) throw new Error('manifest is too old');
    this.lastSeq = m.seq; this.m = m; return m;
  }
  async month(sym, mo) {
    const m = this.m || await this.manifest(), s = m.symbols[sym], e = s && s.months[mo];
    if (!e) throw new Error(`not in manifest: ${sym} ${mo}`);
    const b = await this.read(monthPath(sym, mo, e.v), e.bytes);
    if (!b) throw new Error('month file missing');
    if (b.length !== e.bytes || b.length > LIM.file) throw new Error('month file size mismatch');
    if (sha256(b) !== e.sha256) throw new Error('month file hash mismatch');
    try { zlib.gunzipSync(b, { maxOutputLength: LIM.decoded }); } catch (x) { throw new Error('month file is not valid or too large when decompressed'); }
    let d; try { d = decode(b); } catch (x) { throw new Error('month file structure invalid: ' + x.message); }
    if (d.digits !== s.digits) throw new Error('digits mismatch');
    const r = d.rows; if (r.length !== e.rows) throw new Error('row count mismatch');
    const [y, mm] = mo.split('-').map(Number), lo = Date.UTC(y, mm - 1, 1) / 1e3, hi = Date.UTC(y, mm, 1) / 1e3; let prev = -1;
    for (const k of r) {
      if (k.t % 60 || k.t < lo || k.t >= hi || k.t <= prev) throw new Error('row time invalid');
      if (!(k.o > 0 && k.h > 0 && k.l > 0 && k.c > 0 && k.h >= Math.max(k.o, k.c) && k.l <= Math.min(k.o, k.c) && k.v >= 0)) throw new Error('row ohlc invalid'); prev = k.t;
    }
    if (r.length && ((r[0].t - EPOCH) / 60 !== e.firstMin || (r[r.length - 1].t - EPOCH) / 60 !== e.lastMin)) throw new Error('first/last minute mismatch');
    return d;
  }
}
module.exports = { HubReader };
