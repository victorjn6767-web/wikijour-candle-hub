'use strict';
// CI helper (runner disk only): damages three stored day files in three different ways so the next fetch must detect and repair them.
const fs = require('fs'), path = require('path');
const ID = process.env.DKID || process.env.SYM || 'XAUUSD'; if (!/^[A-Za-z0-9]+$/.test(ID)) { console.error('bad symbol id'); process.exit(2); }
const WORK = process.env.WORK_DIR || path.join(__dirname, '..', 'work'), RAW = path.join(WORK, 'raw', ID);
const days = fs.readdirSync(RAW).filter(f => f.endsWith('.bi5')).sort(); const [a, b, c] = [days[2], days[9], days[16]];
fs.writeFileSync(path.join(RAW, a), fs.readFileSync(path.join(RAW, a)).subarray(0, 20)); // truncated
const buf = fs.readFileSync(path.join(RAW, b)); for (let i = 40; i < buf.length; i += 97) buf[i] ^= 0xff; fs.writeFileSync(path.join(RAW, b), buf); // same size, content flipped
fs.unlinkSync(path.join(RAW, c)); // deleted
console.log([a, b, c].map(x => x.replace('.bi5', '')).join(','));
