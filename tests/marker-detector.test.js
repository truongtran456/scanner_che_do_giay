/* Kiểm thử bộ đọc mã thẻ — chạy: node tests/marker-detector.test.js */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/* Tách riêng object MarkerUtil ra khỏi file để chạy được ngoài trình duyệt */
function loadMarkerUtil(file, endMarker) {
    const src = fs.readFileSync(file, 'utf8');
    const start = src.indexOf('const MarkerUtil = {');
    const end = src.indexOf(endMarker);
    if (start < 0 || end < 0) throw new Error('Không tách được MarkerUtil từ ' + file);
    return new Function(src.slice(start, end) + '\nreturn MarkerUtil;')();
}

const MarkerUtil = loadMarkerUtil(
    path.join(ROOT, 'scanner', 'app.js'),
    '/* ===== CARD SCANNER ===== */'
);

/* --- Dựng ảnh giả: nền trắng, dán mã thẻ đã xoay --- */
function renderMarker(cardNumber, cellPx) {
    const grid = MarkerUtil.getGrid(cardNumber);
    const size = 7 * cellPx;
    const img = new Uint8Array(size * size).fill(255);
    for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 7; c++) {
            if (!grid[r][c]) continue;
            for (let y = r * cellPx; y < (r + 1) * cellPx; y++) {
                for (let x = c * cellPx; x < (c + 1) * cellPx; x++) img[y * size + x] = 0;
            }
        }
    }
    return { img, size };
}

function rotateImage(img, size, times) {
    let cur = img, n = size;
    for (let t = 0; t < times; t++) {
        const out = new Uint8Array(n * n);
        for (let y = 0; y < n; y++) {
            for (let x = 0; x < n; x++) out[x * n + (n - 1 - y)] = cur[y * n + x];
        }
        cur = out;
    }
    return cur;
}

function makeScene(placements, W, H, noise = 0) {
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) {
        let v = 245;
        if (noise) v = Math.max(0, Math.min(255, v + (Math.random() * 2 - 1) * noise));
        rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v;
        rgba[i * 4 + 3] = 255;
    }
    for (const p of placements) {
        const { img, size } = renderMarker(p.cardNumber, p.cellPx);
        const rot = rotateImage(img, size, p.rotations);
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const dx = p.x + x, dy = p.y + y;
                if (dx < 0 || dy < 0 || dx >= W || dy >= H) continue;
                let v = rot[y * size + x];
                if (noise) v = Math.max(0, Math.min(255, v + (Math.random() * 2 - 1) * noise));
                const di = (dy * W + dx) * 4;
                rgba[di] = rgba[di + 1] = rgba[di + 2] = v;
            }
        }
    }
    return rgba;
}

const students = [];
for (let i = 1; i <= 30; i++) {
    students.push({ id: 's' + i, name: 'HS ' + i, cardId: 'CARD-' + i, cardNumber: i });
}

let pass = 0, fail = 0;
function check(label, cond, extra = '') {
    if (cond) { pass++; console.log('  PASS  ' + label); }
    else { fail++; console.log('  FAIL  ' + label + (extra ? ' — ' + extra : '')); }
}

console.log('\n[1] Mã của mỗi thẻ phải khác nhau (kể cả khi xoay)');
{
    const seen = new Map();
    let dup = 0;
    for (const st of students) {
        const key = MarkerUtil.getGrid(st.cardNumber).map(r => r.join('')).join('');
        if (seen.has(key)) dup++;
        seen.set(key, st.cardNumber);
    }
    check('30 thẻ có 30 mã khác nhau', dup === 0, dup + ' trùng');

    let minDist = 99;
    for (let i = 0; i < students.length; i++) {
        for (let j = i + 1; j < students.length; j++) {
            const a = MarkerUtil.getGrid(students[i].cardNumber);
            const b = MarkerUtil.getGrid(students[j].cardNumber);
            let d = 0;
            for (const [r, c] of MarkerUtil.DATA_CELLS) if (a[r][c] !== b[r][c]) d++;
            if (d < minDist) minDist = d;
        }
    }
    check('khoảng cách mã nhỏ nhất >= 7 bit', minDist >= 7, 'min=' + minDist);
}

console.log('\n[2] Một thẻ, 4 hướng xoay → chữ nào lên TOP là đáp án đó');
{
    // xoay ảnh thuận chiều kim đồng hồ p lần → chữ ở cạnh trái lên trên
    const expect = ['A', 'D', 'C', 'B'];
    for (let p = 0; p < 4; p++) {
        const rgba = makeScene([{ cardNumber: 7, cellPx: 14, rotations: p, x: 180, y: 120 }], 640, 480);
        const hits = MarkerUtil.decodeAll(rgba, 640, 480, students);
        const got = hits[0];
        check(
            `xoay ${p * 90}° → thẻ 7, đáp án ${expect[p]}`,
            hits.length === 1 && got.cardNumber === 7 && got.orientation === expect[p],
            hits.length ? `nhận ${got.cardNumber}/${got.orientation}` : 'không nhận được'
        );
    }
}

console.log('\n[3] Năm thẻ cùng lúc trong 1 khung hình');
{
    const placements = [
        { cardNumber: 1, cellPx: 10, rotations: 0, x: 40, y: 60 },
        { cardNumber: 5, cellPx: 10, rotations: 1, x: 200, y: 60 },
        { cardNumber: 12, cellPx: 10, rotations: 2, x: 360, y: 60 },
        { cardNumber: 19, cellPx: 10, rotations: 3, x: 120, y: 260 },
        { cardNumber: 26, cellPx: 10, rotations: 0, x: 340, y: 260 }
    ];
    const rgba = makeScene(placements, 640, 480, 8);
    const hits = MarkerUtil.decodeAll(rgba, 640, 480, students);
    const map = new Map(hits.map(h => [h.cardNumber, h.orientation]));
    check('nhận đủ 5 thẻ', hits.length === 5, 'nhận ' + hits.length);
    check('thẻ 1 → A', map.get(1) === 'A', String(map.get(1)));
    check('thẻ 5 → D', map.get(5) === 'D', String(map.get(5)));
    check('thẻ 12 → C', map.get(12) === 'C', String(map.get(12)));
    check('thẻ 19 → B', map.get(19) === 'B', String(map.get(19)));
    check('thẻ 26 → A', map.get(26) === 'A', String(map.get(26)));
}

console.log('\n[4] Khung hình KHÔNG có thẻ → không được báo gì');
{
    const empty = makeScene([], 640, 480, 25);
    const hits = MarkerUtil.decodeAll(empty, 640, 480, students);
    check('nền trơn: 0 kết quả', hits.length === 0, 'nhận ' + hits.length);

    const rgba = new Uint8ClampedArray(640 * 480 * 4);
    for (let y = 0; y < 480; y++) {
        for (let x = 0; x < 640; x++) {
            const i = (y * 640 + x) * 4;
            const v = ((x >> 4) + (y >> 4)) % 2 ? 30 : 220;
            rgba[i] = rgba[i + 1] = rgba[i + 2] = v;
            rgba[i + 3] = 255;
        }
    }
    const hits2 = MarkerUtil.decodeAll(rgba, 640, 480, students);
    check('nền bàn cờ (nhiễu mạnh): 0 kết quả', hits2.length === 0, 'nhận ' + hits2.length);
}

console.log('\n[5] Thẻ nhỏ / ở xa');
{
    for (const cellPx of [5, 7, 9, 20]) {
        const rgba = makeScene([{ cardNumber: 3, cellPx, rotations: 2, x: 250, y: 180 }], 640, 480, 6);
        const hits = MarkerUtil.decodeAll(rgba, 640, 480, students);
        check(
            `ô ${cellPx}px (mã ${cellPx * 7}px) → thẻ 3 / C`,
            hits.length === 1 && hits[0].cardNumber === 3 && hits[0].orientation === 'C',
            hits.length ? `${hits[0].cardNumber}/${hits[0].orientation}` : 'không nhận'
        );
    }
}

console.log('\n[6] Mã bên desktop và bên scanner phải giống hệt nhau');
const desktopMU = loadMarkerUtil(
    path.join(ROOT, 'app.js'),
    'function syncCardLabels()'
);

{
    let diff = 0;
    for (let n = 1; n <= 40; n++) {
        const a = MarkerUtil.getGrid(n).map(r => r.join('')).join('');
        const b = desktopMU.getGrid(n).map(r => r.join('')).join('');
        if (a !== b) diff++;
    }
    check('40 thẻ: mã desktop khớp scanner', diff === 0, diff + ' thẻ lệch');
}

/* Canvas giả để chạy hàm vẽ thẻ của desktop */
function makeFakeCanvas() {
    const st = { w: 0, h: 0, buf: null };
    const ensure = () => {
        if (!st.buf && st.w && st.h) st.buf = new Uint8Array(st.w * st.h).fill(255);
    };
    const ctx = {
        fillStyle: '#000000',
        fillRect(x, y, w, h) {
            ensure();
            if (!st.buf) return;
            const dark = String(ctx.fillStyle).toLowerCase().replace('#', '');
            const v = (dark === 'fff' || dark === 'ffffff') ? 255 : 0;
            for (let yy = Math.round(y); yy < Math.round(y + h); yy++) {
                for (let xx = Math.round(x); xx < Math.round(x + w); xx++) {
                    if (xx < 0 || yy < 0 || xx >= st.w || yy >= st.h) continue;
                    st.buf[yy * st.w + xx] = v;
                }
            }
        },
        drawImage() {}, save() {}, restore() {}, translate() {}, rotate() {}, fillText() {}
    };
    return {
        get width() { return st.w; },
        set width(v) { st.w = v; st.buf = null; },
        get height() { return st.h; },
        set height(v) { st.h = v; st.buf = null; },
        getContext: () => ctx,
        _st: st
    };
}

console.log('\n[7] End-to-end: thẻ do desktop VẼ RA → scanner đọc đúng tên + đáp án');
{
    for (const [rotP, letter] of [[0, 'A'], [1, 'D'], [2, 'C'], [3, 'B']]) {
        const cv = makeFakeCanvas();
        desktopMU.render(cv, 9, 189);
        const px = cv._st.w;
        let plane = cv._st.buf;
        for (let t = 0; t < rotP; t++) {
            const out = new Uint8Array(px * px);
            for (let y = 0; y < px; y++) {
                for (let x = 0; x < px; x++) out[x * px + (px - 1 - y)] = plane[y * px + x];
            }
            plane = out;
        }

        const W = 640, H = 480;
        const rgba = new Uint8ClampedArray(W * H * 4);
        for (let i = 0; i < W * H; i++) {
            rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = 250;
            rgba[i * 4 + 3] = 255;
        }
        const ox = 200, oy = 140;
        for (let y = 0; y < px; y++) {
            for (let x = 0; x < px; x++) {
                const di = ((oy + y) * W + ox + x) * 4;
                const v = plane[y * px + x];
                rgba[di] = rgba[di + 1] = rgba[di + 2] = v;
            }
        }

        const hits = MarkerUtil.decodeAll(rgba, W, H, students);
        check(
            `thẻ desktop #9 xoay ${rotP * 90}° → "${students[8].name}" chọn ${letter}`,
            hits.length === 1 && hits[0].cardNumber === 9 && hits[0].orientation === letter,
            hits.length ? `${hits[0].cardNumber}/${hits[0].orientation}` : 'không đọc được'
        );
    }
}

console.log('\n[8] Ảnh mờ / tương phản thấp / lệch sáng');
{
    const base = makeScene([{ cardNumber: 14, cellPx: 12, rotations: 3, x: 220, y: 150 }], 640, 480, 4);
    // giả lập chụp thiếu sáng: nén dải sáng + gradient
    const dim = new Uint8ClampedArray(base.length);
    for (let y = 0; y < 480; y++) {
        for (let x = 0; x < 640; x++) {
            const i = (y * 640 + x) * 4;
            const shade = 0.55 + 0.45 * (x / 640);
            const v = Math.round((base[i] * 0.6 + 60) * shade);
            dim[i] = dim[i + 1] = dim[i + 2] = v;
            dim[i + 3] = 255;
        }
    }
    const hits = MarkerUtil.decodeAll(dim, 640, 480, students);
    check(
        'thiếu sáng + lệch sáng → vẫn đọc thẻ 14 / B',
        hits.length === 1 && hits[0].cardNumber === 14 && hits[0].orientation === 'B',
        hits.length ? `${hits[0].cardNumber}/${hits[0].orientation}` : 'không đọc được'
    );
}

console.log('\n[9] Tốc độ xử lý (mỗi khung hình 640x480)');
{
    const rgba = makeScene([
        { cardNumber: 2, cellPx: 11, rotations: 0, x: 60, y: 80 },
        { cardNumber: 8, cellPx: 11, rotations: 2, x: 300, y: 80 },
        { cardNumber: 21, cellPx: 11, rotations: 1, x: 180, y: 280 }
    ], 640, 480, 6);
    const t0 = Date.now();
    const runs = 20;
    let last = [];
    for (let i = 0; i < runs; i++) last = MarkerUtil.decodeAll(rgba, 640, 480, students);
    const ms = (Date.now() - t0) / runs;
    check('nhận đúng 3 thẻ', last.length === 3, 'nhận ' + last.length);
    check(`mỗi khung < 120ms (đo ${ms.toFixed(1)}ms)`, ms < 120, ms.toFixed(1) + 'ms');
}

console.log('\n[10] Xoay khung ngang 270° → đọc đúng như quét dọc');
{
    function rotateRgba90CW(src, w, h, times) {
        let data = src, cw = w, ch = h;
        for (let t = 0; t < times; t++) {
            const out = new Uint8ClampedArray(cw * ch * 4);
            const nw = ch, nh = cw;
            for (let y = 0; y < ch; y++) {
                for (let x = 0; x < cw; x++) {
                    const si = (y * cw + x) * 4;
                    const nx = ch - 1 - y, ny = x;
                    const di = (ny * nw + nx) * 4;
                    out[di] = data[si]; out[di + 1] = data[si + 1];
                    out[di + 2] = data[si + 2]; out[di + 3] = data[si + 3];
                }
            }
            data = out; cw = nw; ch = nh;
        }
        return { data, w: cw, h: ch };
    }

    // mô phỏng camera ngang: thẻ A trên cùng bị đọc thành D (rot=1)
    const raw = makeScene([{ cardNumber: 7, cellPx: 14, rotations: 1, x: 180, y: 120 }], 640, 480);
    const wrong = MarkerUtil.decodeAll(raw, 640, 480, students)[0];
    check('camera ngang thô: đọc D (sai)', wrong?.orientation === 'D', wrong?.orientation || 'none');

    const fixed = rotateRgba90CW(raw, 640, 480, 3); // 270° CW
    const hit = MarkerUtil.decodeAll(fixed.data, fixed.w, fixed.h, students)[0];
    check(
        'xoay khung 270° → thẻ 7 / A (đúng)',
        hit?.cardNumber === 7 && hit?.orientation === 'A',
        hit ? `${hit.cardNumber}/${hit.orientation}` : 'không nhận'
    );
}

console.log(`\n=== ${pass} pass, ${fail} fail ===\n`);
process.exit(fail ? 1 : 0);
