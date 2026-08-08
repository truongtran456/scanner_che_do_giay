'use strict';

const SESSION_STATUS = {
    WAITING: 'WAITING',
    CONNECTED: 'CONNECTED',
    QUESTION_ACTIVE: 'QUESTION_ACTIVE',
    QUESTION_LOCKED: 'QUESTION_LOCKED',
    QUESTION_RESULT: 'QUESTION_RESULT',
    COMPLETED: 'COMPLETED'
};

const appState = {
    sessionId: null,
    session: null,
    soundEnabled: true,
    cameraReady: false,
    cameraStarting: false,
    sessionDataReady: false,
    drawerTab: 'pending',
    lastFlashStudentId: null
};

function $(sel) { return document.querySelector(sel); }
function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function showToast(msg, ms = 2500) {
    const c = $('#toast-container');
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    c.appendChild(t);
    setTimeout(() => t.remove(), ms);
}

function showModal(html) {
    $('#modal-box').innerHTML = html;
    $('#modal-overlay').classList.remove('hidden');
}

function hideModal() {
    $('#modal-overlay').classList.add('hidden');
    $('#modal-box').innerHTML = '';
}

function showView(id) {
    $$('.view').forEach(v => v.classList.remove('active'));
    $(`#view-${id}`)?.classList.add('active');
}

function $$(sel) { return document.querySelectorAll(sel); }

function getShortSessionCode(sessionId) {
    if (!sessionId) return '';
    return sessionId.replace('SESSION-', 'S').slice(0, 8).toUpperCase();
}

function playSound(type) {
    if (!appState.soundEnabled) return;
    try {
        const ctx = playSound._ctx || (playSound._ctx = new (window.AudioContext || window.webkitAudioContext)());
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        const freqs = { scan: 880, lock: 440, next: 550 };
        osc.frequency.value = freqs[type] || 500;
        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);
        osc.start();
        osc.stop(ctx.currentTime + 0.15);
    } catch (_) {}
}

/* ===== SYNC (scanner = client) ===== */
const SyncEngine = {
    peer: null,
    conn: null,
    onMessage: null,
    reconnectTimer: null,
    statePollTimer: null,

    connectScanner(sessionId) {
        return new Promise((resolve) => {
            const hostId = 'pm-' + sessionId;
            try {
                this.peer?.destroy();
                this.peer = new Peer(undefined, {
                    debug: 1,
                    config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }
                });
                this.peer.on('open', () => {
                    const conn = this.peer.connect(hostId, { reliable: true });
                    let settled = false;
                    const done = (ok) => {
                        if (settled) return;
                        settled = true;
                        resolve(ok);
                    };
                    conn.on('data', (data) => this._handle(data));
                    conn.on('open', () => {
                        this.conn = conn;
                        done(true);
                    });
                    conn.on('error', () => done(false));
                    setTimeout(() => done(false), 10000);
                });
                this.peer.on('error', () => resolve(false));
            } catch {
                resolve(false);
            }
        });
    },

    _handle(msg) {
        if (this.onMessage) this.onMessage(msg);
    },

    send(msg) {
        if (this.conn?.open) this.conn.send(msg);
    },

    destroy() {
        clearInterval(this.reconnectTimer);
        clearInterval(this.statePollTimer);
        this.conn?.close();
        this.peer?.destroy();
        this.conn = null;
        this.peer = null;
    },

    requestState() {
        this.send({ type: 'REQUEST_STATE' });
    }
};

/* ===== SESSION HELPERS ===== */
function getCurrentQuestion(session) {
    return session?.questions?.[session.currentQuestionIndex] || null;
}

function getAnswersForQuestion(session, questionId) {
    return (session.answers || []).filter(a => a.questionId === questionId);
}

function getAnswerKey(session, questionId, studentId) {
    return session.answers.findIndex(
        a => a.sessionId === session.id && a.questionId === questionId && a.studentId === studentId
    );
}

function uid(prefix = 'id') {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function recordAnswer(session, studentId, cardId, answer) {
    const q = getCurrentQuestion(session);
    if (!q || session.status === SESSION_STATUS.QUESTION_LOCKED ||
        session.status === SESSION_STATUS.QUESTION_RESULT) return { ok: false };

    if (!session.answers) session.answers = [];

    const existingIdx = getAnswerKey(session, q.id, studentId);
    const record = {
        id: uid('ans'),
        sessionId: session.id,
        questionId: q.id,
        studentId,
        cardId,
        answer,
        isCorrect: null,
        submittedAt: Date.now()
    };

    let updated = false;
    if (existingIdx >= 0) {
        session.answers[existingIdx] = { ...session.answers[existingIdx], answer, submittedAt: Date.now() };
        updated = true;
    } else {
        session.answers.push(record);
    }
    return { ok: true, updated };
}

function getQuestionStats(session, questionId) {
    const ans = getAnswersForQuestion(session, questionId);
    const counts = { A: 0, B: 0, C: 0, D: 0 };
    ans.forEach(a => {
        if (a.answer && counts[a.answer] !== undefined) counts[a.answer]++;
    });
    return { counts, answers: ans };
}

function getSessionSnapshot() {
    const s = appState.session;
    if (!s) return null;
    return JSON.parse(JSON.stringify({
        id: s.id, classId: s.classId, questionSetId: s.questionSetId,
        className: s.className, qsetName: s.qsetName,
        students: s.students, questions: s.questions,
        currentQuestionIndex: s.currentQuestionIndex,
        status: s.status, answers: s.answers,
        scannerConnected: s.scannerConnected, startedAt: s.startedAt
    }));
}

function mergeSession(data) {
    if (!data) return;
    if (!appState.session) {
        appState.session = data;
    } else {
        Object.assign(appState.session, data);
    }
    onSessionUpdated();
}

function onSessionUpdated() {
    const s = appState.session;
    if (!s) return;

    if (s.status === SESSION_STATUS.COMPLETED) {
        CardScanner.stop();
        clearInterval(SyncEngine.statePollTimer);
        showView('ended');
        return;
    }

    if (s.questions?.length && s.students?.length) {
        clearInterval(SyncEngine.statePollTimer);
        appState.sessionDataReady = true;

        const meta = $('#camera-prompt-meta');
        if (meta) {
            meta.textContent = `${s.className || 'Lớp'} · ${s.students.length} HS · ${s.questions.length} câu`;
        }

        if (!appState.cameraReady && !appState.cameraStarting) {
            showView('camera-prompt');
        } else {
            showView('scanner');
            updateOrientationUI();
            renderScanner();
        }
    } else {
        $('#wait-status').textContent = 'Đã kết nối — đang chờ dữ liệu từ máy chiếu...';
    }
}

function handleSyncMessage(msg) {
    if (!msg?.type) return;

    switch (msg.type) {
        case 'STATE_SYNC':
        case 'SESSION_CREATED':
        case 'QUESTION_CHANGED':
        case 'QUESTION_RESULT':
        case 'NEXT_QUESTION':
        case 'QUESTION_LOCKED':
        case 'ANSWER_SCANNED':
        case 'ANSWER_UPDATED':
            if (msg.session) mergeSession(msg.session);
            else renderScanner();
            break;
        case 'SESSION_COMPLETED':
            if (msg.session) mergeSession(msg.session);
            else if (appState.session) {
                appState.session.status = SESSION_STATUS.COMPLETED;
                onSessionUpdated();
            }
            break;
    }
}

/* ===== MARKER (Plickers-style) — nhận diện thẻ số + hướng A/B/C/D ===== */
const MarkerUtil = {
    // rot = số lần xoay thuận chiều kim đồng hồ để đưa ảnh về chuẩn
    ORIENT: ['A', 'B', 'C', 'D'],

    DATA_CELLS: (() => {
        const cells = [];
        for (let r = 1; r <= 5; r++) {
            for (let c = 1; c <= 5; c++) {
                if ((r === 1 || r === 5) && (c === 1 || c === 5)) continue;
                cells.push([r, c]);
            }
        }
        return cells;
    })(),

    MIN_CODE_DISTANCE: 7,
    _book: null,
    _bookSize: 0,

    // Sinh bộ mã sao cho 2 thẻ bất kỳ khác nhau ít nhất 7 ô → chống đọc nhầm
    buildBook(count) {
        const bits = this.DATA_CELLS.length;
        const book = [];
        let seed = 0x1f2e3d4c >>> 0;
        const next = () => {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            return seed;
        };
        let guard = 0;
        while (book.length < count && guard < 500000) {
            guard++;
            const code = new Uint8Array(bits);
            let ones = 0;
            for (let i = 0; i < bits; i++) {
                const b = (next() >>> 18) & 1;
                code[i] = b;
                ones += b;
            }
            if (ones < 6 || ones > bits - 6) continue;
            let ok = true;
            for (const prev of book) {
                let d = 0;
                for (let i = 0; i < bits; i++) if (prev[i] !== code[i]) d++;
                if (d < this.MIN_CODE_DISTANCE) { ok = false; break; }
            }
            if (ok) book.push(code);
        }
        return book;
    },

    getCode(cardNumber) {
        const need = Math.max(60, cardNumber + 10);
        if (!this._book || this._bookSize < need) {
            this._book = this.buildBook(need);
            this._bookSize = need;
        }
        const idx = (Math.max(1, cardNumber) - 1) % this._book.length;
        return this._book[idx];
    },

    getGrid(cardNumber) {
        const grid = Array.from({ length: 7 }, () => Array(7).fill(0));
        for (let i = 0; i < 7; i++) {
            grid[0][i] = grid[6][i] = grid[i][0] = grid[i][6] = 1;
        }
        grid[1][1] = 1;
        grid[1][5] = 0;
        grid[5][1] = 0;
        grid[5][5] = 0;
        const code = this.getCode(cardNumber);
        this.DATA_CELLS.forEach(([r, c], i) => { grid[r][c] = code[i]; });
        return grid;
    },

    rotateGrid(grid, times) {
        let g = grid.map(row => [...row]);
        for (let t = 0; t < times; t++) {
            const n = g.length;
            const rotated = Array.from({ length: n }, () => Array(n).fill(0));
            for (let r = 0; r < n; r++) {
                for (let c = 0; c < n; c++) {
                    rotated[c][n - 1 - r] = g[r][c];
                }
            }
            g = rotated;
        }
        return g;
    },

    toGray(src, sw, sh, maxW) {
        const scale = Math.min(1, maxW / sw);
        const w = Math.max(1, Math.round(sw * scale));
        const h = Math.max(1, Math.round(sh * scale));
        const gray = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) {
            const sy = Math.min(sh - 1, Math.round(y / scale));
            for (let x = 0; x < w; x++) {
                const sx = Math.min(sw - 1, Math.round(x / scale));
                const i = (sy * sw + sx) * 4;
                gray[y * w + x] = (src[i] * 77 + src[i + 1] * 150 + src[i + 2] * 29) >> 8;
            }
        }
        return { gray, w, h };
    },

    adaptiveThreshold(gray, w, h) {
        const iw = w + 1;
        const integral = new Uint32Array(iw * (h + 1));
        for (let y = 0; y < h; y++) {
            let rowSum = 0;
            for (let x = 0; x < w; x++) {
                rowSum += gray[y * w + x];
                integral[(y + 1) * iw + (x + 1)] = integral[y * iw + (x + 1)] + rowSum;
            }
        }
        const bin = new Uint8Array(w * h);
        const half = Math.max(4, Math.round(Math.min(w, h) / 14));
        for (let y = 0; y < h; y++) {
            const y0 = Math.max(0, y - half);
            const y1 = Math.min(h - 1, y + half);
            for (let x = 0; x < w; x++) {
                const x0 = Math.max(0, x - half);
                const x1 = Math.min(w - 1, x + half);
                const area = (y1 - y0 + 1) * (x1 - x0 + 1);
                const sum = integral[(y1 + 1) * iw + (x1 + 1)]
                    - integral[y0 * iw + (x1 + 1)]
                    - integral[(y1 + 1) * iw + x0]
                    + integral[y0 * iw + x0];
                bin[y * w + x] = gray[y * w + x] * area < sum * 0.86 ? 1 : 0;
            }
        }
        return bin;
    },

    findQuads(bin, w, h) {
        const total = w * h;
        const seen = new Uint8Array(total);
        const stack = new Int32Array(total);
        const quads = [];
        const minArea = Math.max(120, Math.round(total / 6000));
        const maxArea = Math.round(total * 0.5);

        for (let start = 0; start < total; start++) {
            if (!bin[start] || seen[start]) continue;

            let sp = 0;
            stack[sp++] = start;
            seen[start] = 1;

            let area = 0;
            let minX = w, maxX = -1, minY = h, maxY = -1;
            let minSum = Infinity, maxSum = -Infinity, minDiff = Infinity, maxDiff = -Infinity;
            let pTL = 0, pBR = 0, pBL = 0, pTR = 0;

            while (sp > 0) {
                const p = stack[--sp];
                const x = p % w;
                const y = (p / w) | 0;
                area++;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
                const s = x + y;
                const d = x - y;
                if (s < minSum) { minSum = s; pTL = p; }
                if (s > maxSum) { maxSum = s; pBR = p; }
                if (d < minDiff) { minDiff = d; pBL = p; }
                if (d > maxDiff) { maxDiff = d; pTR = p; }

                for (let dy = -1; dy <= 1; dy++) {
                    const ny = y + dy;
                    if (ny < 0 || ny >= h) continue;
                    for (let dx = -1; dx <= 1; dx++) {
                        const nx = x + dx;
                        if (nx < 0 || nx >= w) continue;
                        const np = ny * w + nx;
                        if (bin[np] && !seen[np]) {
                            seen[np] = 1;
                            stack[sp++] = np;
                        }
                    }
                }
            }

            if (area < minArea || area > maxArea) continue;

            const bw = maxX - minX + 1;
            const bh = maxY - minY + 1;
            if (bw < 16 || bh < 16) continue;
            const boxRatio = bw / bh;
            if (boxRatio < 0.5 || boxRatio > 2.0) continue;

            const pt = p => ({ x: p % w, y: (p / w) | 0 });
            const quad = [pt(pTL), pt(pTR), pt(pBR), pt(pBL)];
            if (!this.isSquarish(quad, area)) continue;

            quads.push(quad);
            if (quads.length >= 64) break;
        }
        return quads;
    },

    isSquarish(quad, area) {
        const len = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
        const sides = [
            len(quad[0], quad[1]), len(quad[1], quad[2]),
            len(quad[2], quad[3]), len(quad[3], quad[0])
        ];
        const min = Math.min(...sides);
        const max = Math.max(...sides);
        if (min < 14 || min / max < 0.55) return false;

        const quadArea = 0.5 * Math.abs(
            (quad[0].x * quad[1].y - quad[1].x * quad[0].y) +
            (quad[1].x * quad[2].y - quad[2].x * quad[1].y) +
            (quad[2].x * quad[3].y - quad[3].x * quad[2].y) +
            (quad[3].x * quad[0].y - quad[0].x * quad[3].y)
        );
        if (quadArea <= 0) return false;
        const fill = area / quadArea;
        return fill > 0.28 && fill < 1.05;
    },

    samplePerspective(gray, w, h, quad) {
        const n = 7;
        const at = (u, v) => {
            const x = (1 - u) * (1 - v) * quad[0].x + u * (1 - v) * quad[1].x
                + u * v * quad[2].x + (1 - u) * v * quad[3].x;
            const y = (1 - u) * (1 - v) * quad[0].y + u * (1 - v) * quad[1].y
                + u * v * quad[2].y + (1 - u) * v * quad[3].y;
            const xi = Math.round(x);
            const yi = Math.round(y);
            if (xi < 0 || yi < 0 || xi >= w || yi >= h) return -1;
            return gray[yi * w + xi];
        };

        const offsets = [[0.5, 0.5], [0.33, 0.33], [0.67, 0.33], [0.33, 0.67], [0.67, 0.67]];
        const vals = Array.from({ length: n }, () => Array(n).fill(255));
        for (let r = 0; r < n; r++) {
            for (let c = 0; c < n; c++) {
                let sum = 0, count = 0;
                for (const [ou, ov] of offsets) {
                    const v = at((c + ou) / n, (r + ov) / n);
                    if (v >= 0) { sum += v; count++; }
                }
                vals[r][c] = count ? sum / count : 255;
            }
        }
        return vals;
    },

    binarizeCells(vals) {
        const flat = [];
        for (const row of vals) for (const v of row) flat.push(v);
        const min = Math.min(...flat);
        const max = Math.max(...flat);
        if (max - min < 35) return null;

        let threshold = (min + max) / 2;
        let bestVar = -1;
        for (let t = min + 2; t < max; t += 3) {
            let sumLo = 0, nLo = 0, sumHi = 0, nHi = 0;
            for (const v of flat) {
                if (v < t) { sumLo += v; nLo++; } else { sumHi += v; nHi++; }
            }
            if (!nLo || !nHi) continue;
            const diff = sumLo / nLo - sumHi / nHi;
            const varB = nLo * nHi * diff * diff;
            if (varB > bestVar) { bestVar = varB; threshold = t; }
        }
        return vals.map(row => row.map(v => (v < threshold ? 1 : 0)));
    },

    hasBorderRing(grid) {
        let dark = 0;
        for (let i = 0; i < 7; i++) {
            dark += grid[0][i] + grid[6][i];
            if (i > 0 && i < 6) dark += grid[i][0] + grid[i][6];
        }
        return dark >= 21;
    },

    matchGrid(sampled, patterns) {
        for (let rot = 0; rot < 4; rot++) {
            const g = this.rotateGrid(sampled, rot);
            if (g[1][1] !== 1 || g[1][5] !== 0 || g[5][1] !== 0 || g[5][5] !== 0) continue;

            let best = null, secondDist = Infinity;
            for (const p of patterns) {
                let d = 0;
                for (const [r, c] of this.DATA_CELLS) {
                    if (g[r][c] !== p.grid[r][c]) d++;
                }
                if (!best || d < best.d) {
                    secondDist = best ? best.d : secondDist;
                    best = { d, student: p.student };
                } else if (d < secondDist) {
                    secondDist = d;
                }
            }

            if (!best || best.d > 3) continue;
            if (secondDist - best.d < 2) continue;

            return {
                student: best.student,
                cardId: best.student.cardId,
                cardNumber: best.student.cardNumber,
                orientation: this.ORIENT[rot],
                dist: best.d
            };
        }
        return null;
    },

    stats: { quads: 0, decoded: 0 },

    correctOrientation(letter, offset) {
        const i = this.ORIENT.indexOf(letter);
        if (i < 0 || !offset) return letter;
        return this.ORIENT[(i + offset) % 4];
    },

    decodeAll(imageData, width, height, students) {
        this.stats.quads = 0;
        this.stats.decoded = 0;
        if (!students?.length) return [];

        const { gray, w, h } = this.toGray(imageData, width, height, 640);
        const bin = this.adaptiveThreshold(gray, w, h);
        const quads = this.findQuads(bin, w, h);
        this.stats.quads = quads.length;
        if (!quads.length) return [];

        const patterns = students.map(st => ({
            student: st,
            grid: this.getGrid(st.cardNumber)
        }));

        const byCard = new Map();
        for (const quad of quads) {
            const vals = this.samplePerspective(gray, w, h, quad);
            const sampled = this.binarizeCells(vals);
            if (!sampled || !this.hasBorderRing(sampled)) continue;

            const hit = this.matchGrid(sampled, patterns);
            if (!hit) continue;

            const prev = byCard.get(hit.cardId);
            if (!prev || hit.dist < prev.dist) byCard.set(hit.cardId, hit);
        }

        this.stats.decoded = byCard.size;
        return Array.from(byCard.values());
    }
};

/* ===== HƯỚNG MÀN HÌNH — quét chuẩn khi xoay ngang ===== */
const ScanOrientation = {
    _landscape: false,
    _angle: 0,
    _type: 'portrait-primary',
    _onChange: null,

    init(onChange) {
        this._onChange = onChange;
        this._read();
        const fire = () => setTimeout(() => this._handleChange(), 120);
        window.addEventListener('orientationchange', fire);
        window.addEventListener('resize', () => this._handleChange());
        if (screen.orientation) screen.orientation.addEventListener('change', fire);
        this._handleChange();
    },

    _read() {
        this._landscape = window.innerWidth > window.innerHeight;
        if (screen.orientation) {
            this._angle = screen.orientation.angle;
            this._type = screen.orientation.type;
        } else {
            this._angle = window.orientation || 0;
            this._type = this._landscape ? 'landscape-primary' : 'portrait-primary';
        }
    },

    _handleChange() {
        const wasLandscape = this._landscape;
        this._read();
        updateOrientationUI();
        if (wasLandscape !== this._landscape && this._onChange) this._onChange();
    },

    isLandscape() {
        return this._landscape;
    },

    /** Bù đáp án khi quét ngang (cảm biến camera lệch 90° so với dọc) */
    getOrientOffset() {
        if (!this._landscape) return null;
        if (this._type === 'landscape-secondary') return 3;
        return 1; // landscape-primary: xoay ngang → đọc lệch 1 bước (D thay A)
    },

    async tryLockLandscape() {
        try {
            if (screen.orientation?.lock) await screen.orientation.lock('landscape');
        } catch (_) { /* iOS Safari thường không cho lock */ }
    }
};

function updateOrientationUI() {
    const prompt = $('#orientation-prompt');
    const view = $('#view-scanner');
    const landscape = ScanOrientation.isLandscape();

    prompt?.classList.toggle('hidden', landscape || !appState.cameraReady);
    view?.classList.toggle('scan-landscape', landscape);

    const tip = $('#scan-frame-tip');
    if (tip) {
        tip.textContent = landscape
            ? 'Giơ thẻ dọc — đáp án ở trên cùng'
            : 'Xoay ngang máy để bắt đầu quét';
    }
}

function captureScanFrame(video, canvas) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;

    canvas.width = vw;
    canvas.height = vh;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0);
    return ctx.getImageData(0, 0, vw, vh);
}

/* ===== CARD SCANNER ===== */
const CardScanner = {
    stream: null,
    rafId: null,
    frameCount: 0,
    pending: new Map(),
    confirmed: new Map(),
    questionKey: null,
    CONFIRM_FRAMES: 2,

    resetForQuestion(questionId) {
        this.pending.clear();
        this.confirmed.clear();
        this.questionKey = questionId;
    },

    async start(videoEl, canvasEl) {
        if (this.stream) return true;
        try {
            this.stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: { ideal: 'environment' },
                    width: { ideal: 1280 },
                    height: { ideal: 720 }
                },
                audio: false
            });
            videoEl.srcObject = this.stream;
            videoEl.setAttribute('playsinline', 'true');
            videoEl.muted = true;
            await videoEl.play();
            this._loop(videoEl, canvasEl);
            appState.cameraReady = true;
            return true;
        } catch (e) {
            console.warn('Camera error:', e);
            return false;
        }
    },

    stop() {
        cancelAnimationFrame(this.rafId);
        this.stream?.getTracks().forEach(t => t.stop());
        this.stream = null;
        this.pending.clear();
        this.confirmed.clear();
        this.frameCount = 0;
        appState.cameraReady = false;
    },

    _loop(video, canvas) {
        const tick = () => {
            if (!this.stream) return;
            if (video.readyState === video.HAVE_ENOUGH_DATA && ScanOrientation.isLandscape()) {
                const img = captureScanFrame(video, canvas);
                if (img) {
                    this.frameCount++;
                    this._scanFrame(img);
                }
            }
            this.rafId = requestAnimationFrame(tick);
        };
        tick();
    },

    _scanFrame(img) {
        const students = appState.session?.students || [];
        if (!students.length) return;
        if (!ScanOrientation.isLandscape()) return;
        if (this.frameCount % 3 !== 0) return;

        const orientOffset = ScanOrientation.getOrientOffset() || 0;
        let hits = MarkerUtil.decodeAll(img.data, img.width, img.height, students);
        if (orientOffset) {
            hits = hits.map(h => ({
                ...h,
                orientation: MarkerUtil.correctOrientation(h.orientation, orientOffset)
            }));
        }
        const seen = new Set();

        for (const hit of hits) {
            seen.add(hit.cardId);
            this._trackHit(hit);
        }

        for (const [cardId, p] of this.pending) {
            if (!seen.has(cardId)) {
                p.missed = (p.missed || 0) + 1;
                if (p.missed >= 3) this.pending.delete(cardId);
            }
        }
    },

    _trackHit(hit) {
        const q = getCurrentQuestion(appState.session);
        if (!q) return;

        if (this.questionKey !== q.id) this.resetForQuestion(q.id);

        const confirmKey = `${q.id}_${hit.cardId}`;
        const already = this.confirmed.get(confirmKey);
        if (already === hit.orientation) return;

        const existing = appState.session.answers.find(
            a => a.questionId === q.id && a.studentId === hit.student.id
        );
        if (existing?.answer === hit.orientation) {
            this.confirmed.set(confirmKey, hit.orientation);
            return;
        }

        let p = this.pending.get(hit.cardId);
        if (p && p.orientation === hit.orientation) {
            p.frames++;
            p.missed = 0;
        } else {
            p = { orientation: hit.orientation, frames: 1, missed: 0, student: hit.student };
            this.pending.set(hit.cardId, p);
        }

        if (p.frames >= this.CONFIRM_FRAMES) {
            this.pending.delete(hit.cardId);
            this.confirmed.set(confirmKey, hit.orientation);
            this._fireScan(hit.cardId, hit.orientation, hit.student);
        }
    },

    _fireScan(cardId, orientation, knownStudent) {
        onCardScanned(cardId, orientation, knownStudent);
    }
};

function onCardScanned(cardId, orientation, knownStudent = null) {
    const s = appState.session;
    if (!s?.students?.length) return;
    if (s.status === SESSION_STATUS.QUESTION_LOCKED || s.status === SESSION_STATUS.QUESTION_RESULT) return;

    const student = knownStudent || s.students.find(st => st.cardId === cardId);
    if (!student) {
        showScanFlash('Không tìm thấy thẻ này', true);
        return;
    }

    const result = recordAnswer(s, student.id, cardId, orientation);
    if (!result.ok) return;

    const eventType = result.updated ? 'ANSWER_UPDATED' : 'ANSWER_SCANNED';
    const q = getCurrentQuestion(s);
    SyncEngine.send({
        type: eventType,
        studentId: student.id,
        cardId,
        answer: orientation,
        questionId: q?.id,
        session: getSessionSnapshot()
    });

    const tag = $('#scan-last-flash');
    if (tag) {
        tag.textContent = result.updated
            ? `↻ ${student.name} → ${orientation}`
            : `✓ ${student.name} · ${orientation}`;
        tag.classList.remove('hidden', 'update');
        if (result.updated) tag.classList.add('update');
        appState.lastFlashStudentId = student.id;
        clearTimeout(showScanFlash._t);
        showScanFlash._t = setTimeout(() => tag.classList.add('hidden'), 900);
    }

    playSound('scan');
    renderScanner();
}

function showScanFlash(text, isUpdate = false) {
    const el = $('#scan-last-flash');
    if (!el) return;
    el.textContent = text;
    el.classList.remove('hidden');
    el.classList.toggle('update', isUpdate);
    clearTimeout(showScanFlash._t);
    showScanFlash._t = setTimeout(() => el.classList.add('hidden'), 900);
}

function renderScanner() {
    const s = appState.session;
    if (!s?.questions?.length) return;

    const q = getCurrentQuestion(s);
    if (q && CardScanner.questionKey !== q.id) {
        CardScanner.resetForQuestion(q.id);
    }

    const answeredList = getAnswersForQuestion(s, q?.id).filter(a => a.answer);
    const answered = answeredList.length;
    const total = s.students.length;
    const pending = total - answered;
    const pct = total ? Math.round((answered / total) * 100) : 0;
    const isResult = s.status === SESSION_STATUS.QUESTION_RESULT;

    $('#scan-q-pill').textContent = `Câu ${s.currentQuestionIndex + 1}/${s.questions.length}`;
    $('#scan-count-pill').textContent = `${answered}/${total}`;
    $('#scan-progress-fill').style.width = pct + '%';
    $('#scan-pending-count').textContent = pending;
    $('#tab-pending-n').textContent = pending;
    $('#tab-done-n').textContent = answered;

    const lockBtn = $('#btn-lock-question');
    if (lockBtn) {
        lockBtn.classList.toggle('ready', pending === 0 && !isResult);
        lockBtn.textContent = pending === 0 && !isResult ? '🔒 CHỐT — ĐỦ RỒI!' : '🔒 CHỐT CÂU';
    }

    const activeDock = $('#scanner-active');
    const resultDock = $('#scanner-result');
    if (activeDock) activeDock.classList.toggle('hidden', isResult);
    if (resultDock) resultDock.classList.toggle('hidden', !isResult);

    renderStudentDrawer(s, q);

    if (isResult && q) {
        const stats = getQuestionStats(s, q.id);
        $('#scan-result-summary').textContent = `✓ Đáp án: ${q.correctAnswer} · ${answered}/${total} HS`;
        const max = Math.max(1, ...['A', 'B', 'C', 'D'].map(id => stats.counts[id] || 0));
        $('#scan-result-bars').innerHTML = ['A', 'B', 'C', 'D'].map(id => {
            const n = stats.counts[id] || 0;
            return `<div class="result-bar-row"><span>${id}${id === q.correctAnswer ? '✓' : ''}</span>
                <div class="result-bar-track"><div class="result-bar-fill" style="width:${Math.round(n / max * 100)}%"></div></div>
                <span>${n}</span></div>`;
        }).join('');
    }
}

function renderStudentDrawer(s, q) {
    const list = $('#scanner-student-list');
    if (!list) return;

    const tab = appState.drawerTab;
    let rows = s.students.map(st => {
        const a = s.answers.find(x => x.questionId === q?.id && x.studentId === st.id);
        const done = !!a?.answer;
        return { st, done, ans: a?.answer || '—' };
    });

    if (tab === 'pending') rows = rows.filter(r => !r.done);
    else if (tab === 'done') rows = rows.filter(r => r.done);

    rows.sort((a, b) => {
        if (a.done !== b.done) return a.done ? 1 : -1;
        return (a.st.cardNumber || 0) - (b.st.cardNumber || 0);
    });

    list.innerHTML = rows.length ? rows.map(({ st, done, ans }) => `
        <div class="scan-student-row ${done ? 'done' : 'pending'}${st.id === appState.lastFlashStudentId ? ' just-scanned' : ''}" data-id="${st.id}">
            <span>Thẻ ${st.cardNumber} · ${esc(st.name)}</span>
            <span class="ans-badge">${esc(ans)}</span>
        </div>
    `).join('') : `<p style="text-align:center;opacity:0.5;padding:1rem;font-weight:700;">${tab === 'pending' ? '🎉 Tất cả đã quét!' : 'Chưa ai quét'}</p>`;
}

async function startCamera() {
    if (appState.cameraReady || appState.cameraStarting) return appState.cameraReady;
    appState.cameraStarting = true;

    const loading = $('#camera-loading');
    loading?.classList.remove('hidden');

    const video = $('#scanner-video');
    const canvas = $('#scanner-canvas');
    let ok = false;

    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
        ok = await CardScanner.start(video, canvas);
        if (!ok && attempt === 0) await new Promise(r => setTimeout(r, 600));
    }

    loading?.classList.add('hidden');
    appState.cameraStarting = false;

    if (ok) {
        showView('scanner');
        updateOrientationUI();
        ScanOrientation.tryLockLandscape();
        renderScanner();
    } else {
        showToast('Không mở được camera — kiểm tra quyền truy cập');
        showView('camera-prompt');
    }
    return ok;
}

function confirmLockQuestion() {
    const s = appState.session;
    const q = getCurrentQuestion(s);
    if (!q) return;
    const answered = getAnswersForQuestion(s, q.id).filter(a => a.answer).length;
    const missing = s.students.length - answered;

    if (missing > 0) {
        showModal(`
            <h3>⚠ Còn ${missing} học sinh chưa trả lời</h3>
            <p>Bạn vẫn muốn chốt câu?</p>
            <div class="modal-actions">
                <button class="btn btn-secondary" id="mc-cancel">Quay lại</button>
                <button class="btn btn-primary" id="mc-ok">Chốt câu</button>
            </div>
        `);
        $('#mc-cancel').onclick = hideModal;
        $('#mc-ok').onclick = () => { hideModal(); doLockQuestion(); };
    } else {
        doLockQuestion();
    }
}

function doLockQuestion() {
    SyncEngine.send({ type: 'LOCK_QUESTION' });
    setTimeout(() => SyncEngine.send({ type: 'REQUEST_STATE' }), 400);
    playSound('lock');
}

function showChoosersModal() {
    const s = appState.session;
    const q = getCurrentQuestion(s);
    const stats = getQuestionStats(s, q.id);
    const byAnswer = { A: [], B: [], C: [], D: [] };

    stats.answers.forEach(a => {
        if (a.answer && byAnswer[a.answer]) {
            const st = s.students.find(x => x.id === a.studentId);
            if (st) byAnswer[a.answer].push(st.name);
        }
    });

    showModal(`
        <h3>👁 Người chọn — Câu ${s.currentQuestionIndex + 1}</h3>
        <div class="choosers-list">
            ${['A', 'B', 'C', 'D'].map(id => `
                <div class="chooser-group ${id === q.correctAnswer ? 'correct' : ''}">
                    <h4>${id}${id === q.correctAnswer ? ' ✓' : ''}</h4>
                    <ul>${(byAnswer[id].length ? byAnswer[id] : ['—']).map(n => `<li>${esc(n)}</li>`).join('')}</ul>
                </div>
            `).join('')}
        </div>
        <div class="modal-actions"><button class="btn btn-primary" id="mc-close">Đóng</button></div>
    `);
    $('#mc-close').onclick = hideModal;
}

function confirmEndSession() {
    const s = appState.session;
    showModal(`
        <h3>🛑 Kết thúc phiên?</h3>
        <p>${s?.students?.length || 0} học sinh</p>
        <div class="modal-actions">
            <button class="btn btn-secondary" id="me-cancel">Hủy</button>
            <button class="btn btn-primary" id="me-ok" style="background:#ef4444;">Kết thúc</button>
        </div>
    `);
    $('#me-cancel').onclick = hideModal;
    $('#me-ok').onclick = () => { hideModal(); SyncEngine.send({ type: 'END_SESSION' }); };
}

function startReconnectLoop(sessionId) {
    SyncEngine.reconnectTimer = setInterval(async () => {
        if (!SyncEngine.conn?.open) {
            $('#scanner-reconnect')?.classList.remove('hidden');
            const ok = await SyncEngine.connectScanner(sessionId);
            if (ok) {
                $('#scanner-reconnect')?.classList.add('hidden');
                notifyHostConnected();
                startStatePoll();
                $('#wait-status').textContent = 'Đã kết nối lại';
            }
        }
    }, 5000);
}

function startStatePoll() {
    clearInterval(SyncEngine.statePollTimer);
    SyncEngine.statePollTimer = setInterval(() => {
        if (appState.session?.questions?.length && appState.session?.students?.length) {
            clearInterval(SyncEngine.statePollTimer);
            onSessionUpdated();
            return;
        }
        if (SyncEngine.conn?.open) SyncEngine.requestState();
    }, 2000);
}

function notifyHostConnected() {
    SyncEngine.send({ type: 'SCANNER_CONNECTED', from: 'scanner' });
    SyncEngine.requestState();
}

async function init(sessionId) {
    appState.sessionId = sessionId;
    appState.session = { id: sessionId, status: SESSION_STATUS.WAITING, students: [], questions: [], answers: [] };

    $('#wait-session').textContent = getShortSessionCode(sessionId);
    showView('waiting');

    SyncEngine.onMessage = handleSyncMessage;

    const connected = await SyncEngine.connectScanner(sessionId);
    if (connected) {
        notifyHostConnected();
        $('#wait-status').textContent = 'Đã kết nối — đang lấy dữ liệu từ máy chiếu...';
        startStatePoll();
    } else {
        $('#wait-status').textContent = 'Chưa kết nối — mở phiên trên máy tính trước, rồi quét lại QR';
        showToast('Đang thử kết nối lại...');
    }

    startReconnectLoop(sessionId);
}

function showScanMenu() {
    const s = appState.session;
    showModal(`
        <h3>☰ Quản lý quét</h3>
        <ul class="menu-list">
            <li><button type="button" id="mm-drawer">👥 Danh sách học sinh</button></li>
            <li><button type="button" id="mm-choosers">👁 Ai chọn đáp án gì</button></li>
            <li><button type="button" id="mm-resync">🔄 Đồng bộ lại máy chiếu</button></li>
            <li><button type="button" class="danger" id="mm-end">🛑 Kết thúc phiên</button></li>
        </ul>
        <div class="modal-actions"><button class="btn btn-secondary btn-sm" id="mm-close">Đóng</button></div>
    `);
    $('#mm-close').onclick = hideModal;
    $('#mm-drawer').onclick = () => { hideModal(); $('#scanner-drawer')?.classList.remove('hidden'); };
    $('#mm-choosers').onclick = () => { hideModal(); showChoosersModal(); };
    $('#mm-resync').onclick = () => { hideModal(); SyncEngine.requestState(); showToast('Đang đồng bộ...'); };
    $('#mm-end').onclick = () => { hideModal(); confirmEndSession(); };
}

function bindEvents() {
    $('#btn-start-camera')?.addEventListener('click', () => startCamera());
    $('#btn-lock-question')?.addEventListener('click', confirmLockQuestion);
    $('#btn-scan-menu')?.addEventListener('click', showScanMenu);
    $('#btn-toggle-drawer')?.addEventListener('click', () => {
        const d = $('#scanner-drawer');
        d?.classList.toggle('hidden');
        if (!d?.classList.contains('hidden')) renderScanner();
    });
    $$('.drawer-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            $$('.drawer-tab').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            appState.drawerTab = btn.dataset.tab;
            renderScanner();
        });
    });
    $('#btn-next-q-result')?.addEventListener('click', () => {
        SyncEngine.send({ type: 'NEXT_QUESTION' });
        setTimeout(() => SyncEngine.send({ type: 'REQUEST_STATE' }), 400);
        playSound('next');
    });
    $('#btn-show-choosers')?.addEventListener('click', showChoosersModal);
    $('#modal-overlay')?.addEventListener('click', e => {
        if (e.target === $('#modal-overlay')) hideModal();
    });
    document.addEventListener('click', e => {
        const drawer = $('#scanner-drawer');
        if (drawer && !drawer.classList.contains('hidden') &&
            !drawer.contains(e.target) && !e.target.closest('#btn-toggle-drawer')) {
            drawer.classList.add('hidden');
        }
    });
}

document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    ScanOrientation.init(() => {
        CardScanner.pending.clear();
        CardScanner.confirmed.clear();
    });
    const params = new URLSearchParams(location.search);
    const sessionId = params.get('session');
    if (!sessionId) {
        showView('no-session');
        return;
    }
    init(sessionId);
});
