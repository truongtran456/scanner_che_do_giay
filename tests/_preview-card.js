/* Xuất ảnh PNG minh hoạ thẻ mới (chạy: node tests/_preview-card.js) */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const start = src.indexOf('const MarkerUtil = {');
const end = src.indexOf('function syncCardLabels()');
const MarkerUtil = new Function(src.slice(start, end) + '\nreturn MarkerUtil;')();

const GLYPH = {
    A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
    B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
    C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
    D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110']
};

function rotateGlyph(rows, times) {
    let g = rows.map(r => r.split('').map(Number));
    for (let t = 0; t < times; t++) {
        const h = g.length, w = g[0].length;
        const out = Array.from({ length: w }, () => Array(h).fill(0));
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[x][h - 1 - y] = g[y][x];
        g = out;
    }
    return g;
}

function drawGlyph(buf, W, letter, rotations, cx, cy, scale) {
    const g = rotateGlyph(GLYPH[letter], rotations);
    const gh = g.length, gw = g[0].length;
    const x0 = Math.round(cx - (gw * scale) / 2);
    const y0 = Math.round(cy - (gh * scale) / 2);
    for (let y = 0; y < gh; y++) {
        for (let x = 0; x < gw; x++) {
            if (!g[y][x]) continue;
            for (let dy = 0; dy < scale; dy++) {
                for (let dx = 0; dx < scale; dx++) {
                    const px = x0 + x * scale + dx;
                    const py = y0 + y * scale + dy;
                    if (px < 0 || py < 0 || px >= W) continue;
                    buf[py * W + px] = 0;
                }
            }
        }
    }
}

function buildCard(cardNumber) {
    const markerPx = 252;
    const pad = 54;
    const W = markerPx + pad * 2;
    const H = markerPx + pad * 2;
    const buf = new Uint8Array(W * H).fill(255);

    const st = { w: 0, h: 0, b: null };
    const ctx = {
        fillStyle: '#000',
        fillRect(x, y, w, h) {
            if (!st.b) st.b = new Uint8Array(st.w * st.h).fill(255);
            const f = String(ctx.fillStyle).toLowerCase();
            const v = (f === '#fff' || f === '#ffffff') ? 255 : 0;
            for (let yy = Math.round(y); yy < Math.round(y + h); yy++)
                for (let xx = Math.round(x); xx < Math.round(x + w); xx++) {
                    if (xx < 0 || yy < 0 || xx >= st.w || yy >= st.h) continue;
                    st.b[yy * st.w + xx] = v;
                }
        }
    };
    const canvas = {
        get width() { return st.w; }, set width(v) { st.w = v; st.b = null; },
        get height() { return st.h; }, set height(v) { st.h = v; st.b = null; },
        getContext: () => ctx
    };
    MarkerUtil.render(canvas, cardNumber, markerPx);

    for (let y = 0; y < markerPx; y++)
        for (let x = 0; x < markerPx; x++)
            buf[(pad + y) * W + pad + x] = st.b[y * markerPx + x];

    drawGlyph(buf, W, 'A', 0, W / 2, pad / 2, 5);
    drawGlyph(buf, W, 'C', 2, W / 2, H - pad / 2, 5);
    drawGlyph(buf, W, 'D', 3, pad / 2, H / 2, 5);
    drawGlyph(buf, W, 'B', 1, W - pad / 2, H / 2, 5);

    return { buf, W, H };
}

function writePng(file, gray, W, H) {
    const raw = Buffer.alloc((W + 1) * H);
    for (let y = 0; y < H; y++) {
        raw[y * (W + 1)] = 0;
        Buffer.from(gray.subarray(y * W, (y + 1) * W)).copy(raw, y * (W + 1) + 1);
    }
    const chunk = (type, data) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(body) >>> 0);
        return Buffer.concat([len, body, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(W, 0);
    ihdr.writeUInt32BE(H, 4);
    ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0))
    ]);
    fs.writeFileSync(file, png);
}

let TABLE = null;
function crc32(buf) {
    if (!TABLE) {
        TABLE = new Int32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            TABLE[n] = c;
        }
    }
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return c ^ -1;
}

const out = path.join(ROOT, 'tests', 'the-mau.png');
const { buf, W, H } = buildCard(1);
writePng(out, buf, W, H);
console.log('Đã tạo:', out, `${W}x${H}`);
