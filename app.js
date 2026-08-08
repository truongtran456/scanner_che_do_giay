'use strict';

/* ============================================================
   THẺ XOAY — Quét thẻ học sinh
   Single-file logic: data, sync, scanner, session, UI
   ============================================================ */

const STORAGE = {
    CLASSES: 'paperModeClasses',
    QSETS: 'paperModeQuestionSets',
    HISTORY: 'paperModeSessions',
    SETTINGS: 'paperModeSettings'
};

const SESSION_STATUS = {
    WAITING: 'WAITING',
    CONNECTED: 'CONNECTED',
    QUESTION_ACTIVE: 'QUESTION_ACTIVE',
    QUESTION_LOCKED: 'QUESTION_LOCKED',
    QUESTION_RESULT: 'QUESTION_RESULT',
    COMPLETED: 'COMPLETED',
    RANKING: 'RANKING'
};

const SYNC_EVENTS = [
    'SESSION_CREATED', 'SCANNER_CONNECTED', 'QUESTION_CHANGED',
    'ANSWER_SCANNED', 'ANSWER_UPDATED', 'QUESTION_LOCKED',
    'QUESTION_RESULT', 'NEXT_QUESTION', 'SESSION_COMPLETED', 'RANKING_UPDATED', 'STATE_SYNC'
];

const appState = {
    role: null,
    currentClassId: null,
    currentQSetId: null,
    editingClassId: null,
    editingQSetId: null,
    session: null,
    soundEnabled: true,
    analyticsSession: null,
    presenterFontSize: 32,
    lastScannedStudentId: null,
    printClassId: null
};

/* ===== UTILS ===== */
function uid(prefix = 'id') {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function genSessionId() {
    return 'SESSION-' + Math.random().toString(36).slice(2, 7).toUpperCase();
}

function genCardId() {
    return 'CARD-' + Math.random().toString(36).slice(2, 7).toUpperCase();
}

function getSettings() {
    return IDBStore.cache.settings;
}

function saveSettings(settings) {
    IDBStore.cache.settings = { ...IDBStore.cache.settings, ...settings };
    IDBStore.persist('settings');
}

function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }

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

function getShortSessionCode(sessionId) {
    if (!sessionId) return '';
    return sessionId.replace('SESSION-', 'S').slice(0, 8).toUpperCase();
}

/* ===== NETWORK / URL app quét (Vercel) ===== */
function getScannerUrl(sessionId) {
    return PaperModeConfig.getScannerJoinUrl(sessionId);
}

function renderConnectQr(url) {
    const qrBox = $('#connect-qr');
    const placeholder = $('#connect-qr-placeholder');
    if (!qrBox) return;

    qrBox.querySelectorAll('canvas, img').forEach(el => el.remove());

    if (!url) {
        placeholder?.classList.remove('hidden');
        placeholder.textContent = 'Chưa có link quét';
        return;
    }
    placeholder?.classList.add('hidden');

    const img = document.createElement('img');
    img.alt = 'QR quét điện thoại';
    img.width = 180;
    img.height = 180;
    img.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(url)}`;
    qrBox.appendChild(img);
}

/* ===== MARKER (Plickers-style) — phải khớp hệt scanner/app.js ===== */
const MarkerUtil = {
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

    // Vẽ mã: ô liền nhau (không khe hở) + viền trắng quanh mã để camera tách khối
    render(canvas, cardNumber, px = 280) {
        const quiet = px / 9;
        const markerSize = px - quiet * 2;
        const cell = markerSize / 7;
        canvas.width = px;
        canvas.height = px;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, px, px);
        ctx.fillStyle = '#000000';
        const grid = this.getGrid(cardNumber);
        for (let r = 0; r < 7; r++) {
            for (let c = 0; c < 7; c++) {
                if (!grid[r][c]) continue;
                const x = quiet + c * cell;
                const y = quiet + r * cell;
                ctx.fillRect(Math.floor(x), Math.floor(y), Math.ceil(cell) + 1, Math.ceil(cell) + 1);
            }
        }
    },

    draw(canvas, cardNumber) {
        this.render(canvas, cardNumber);
    },

    drawPreview(canvas, cardNumber) {
        this.render(canvas, cardNumber);
    },

    drawAsync(canvas, cardNumber) {
        this.render(canvas, cardNumber, 560);
        return Promise.resolve();
    }
};

function syncCardLabels() {
    const ta = $('#class-students');
    const col = $('#card-labels-col');
    if (!ta || !col) return;
    const rawLines = ta.value.split('\n');
    const lines = rawLines.length === 0 ? [''] : rawLines;
    let cardNum = 0;
    col.innerHTML = lines.map(line => {
        const trimmed = line.trim();
        let label = '';
        if (trimmed) {
            cardNum++;
            label = `Thẻ ${cardNum}`;
        }
        return `<div class="card-label-row${trimmed ? '' : ' empty'}">${label}</div>`;
    }).join('');
}

function bindStudentEditorScroll() {
    const ta = $('#class-students');
    const col = $('#card-labels-col');
    if (!ta || !col || ta.dataset.scrollBound) return;
    ta.dataset.scrollBound = '1';
    ta.addEventListener('scroll', () => { col.scrollTop = ta.scrollTop; });
}

function playSound(type) {
    if (!appState.soundEnabled) return;
    const ctx = playSound._ctx || (playSound._ctx = new (window.AudioContext || window.webkitAudioContext)());
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    const freqs = { scan: 880, lock: 440, correct: 660, next: 550, complete: 523 };
    osc.frequency.value = freqs[type] || 500;
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
}

/* ===== KaTeX / MATH ===== */
function _normalizeLatex(latex) {
    if (!latex) return '';
    let s = latex.trim().replace(/\\\\/g, '\\');
    if (s.startsWith('$') && s.endsWith('$')) s = s.slice(1, -1);
    return s.trim();
}

function _splitMathContent(text) {
    if (!text) return [{ type: 'text', value: '' }];
    const parts = [];
    const re = /\$([^$]+)\$/g;
    let last = 0, m;
    while ((m = re.exec(text)) !== null) {
        if (m.index > last) parts.push({ type: 'text', value: text.slice(last, m.index) });
        parts.push({ type: 'math', value: m[1] });
        last = m.index + m[0].length;
    }
    if (last < text.length) parts.push({ type: 'text', value: text.slice(last) });
    if (!parts.length) parts.push({ type: 'text', value: text });
    return parts;
}

function _latexToHtml(latex) {
    const n = _normalizeLatex(latex);
    if (!n || !window.katex) return n;
    try {
        return katex.renderToString(n, { throwOnError: false });
    } catch {
        return n;
    }
}

function _renderTextOrLatex(text, element) {
    if (!element) return;
    const raw = text || '';
    const parts = _splitMathContent(raw);
    element.innerHTML = parts.map(p => {
        if (p.type === 'math') return _latexToHtml(p.value);
        return p.value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
    }).join('');
}

function updateLivePreview(textarea) {
    const preview = textarea.parentElement.querySelector('.qm-live-preview');
    if (preview) _renderTextOrLatex(textarea.value, preview);
}

/* ===== DATA STORE (IndexedDB) ===== */
const DataStore = {
    getClasses() { return IDBStore.cache.classes; },
    saveClasses(list) { IDBStore.cache.classes = list; IDBStore.persist('classes'); },

    getClass(id) { return this.getClasses().find(c => c.id === id); },

    createClass(name, studentNames) {
        const classId = uid('class');
        const students = studentNames.filter(n => n.trim()).map((name, i) => ({
            id: uid('student'),
            name: name.trim(),
            classId,
            cardId: genCardId(),
            cardNumber: i + 1
        }));
        const cls = { id: classId, name, createdAt: Date.now(), students };
        const list = this.getClasses();
        list.push(cls);
        this.saveClasses(list);
        return cls;
    },

    updateClass(id, name, studentNames) {
        const list = this.getClasses();
        const idx = list.findIndex(c => c.id === id);
        if (idx < 0) return null;
        const old = list[idx];
        const students = studentNames.filter(n => n.trim()).map((name, i) => {
            const trimmed = name.trim();
            const existing = old.students.find(s => s.name === trimmed) || old.students[i];
            if (existing && existing.name === trimmed) {
                return { ...existing, cardNumber: i + 1 };
            }
            return {
                id: uid('student'),
                name: trimmed,
                classId: id,
                cardId: genCardId(),
                cardNumber: i + 1
            };
        });
        list[idx] = { ...old, name, students };
        this.saveClasses(list);
        return list[idx];
    },

    deleteClass(id) {
        this.saveClasses(this.getClasses().filter(c => c.id !== id));
    },

    getQuestionSets() { return IDBStore.cache.questionSets; },
    saveQuestionSets(list) { IDBStore.cache.questionSets = list; IDBStore.persist('questionSets'); },

    getQuestionSet(id) { return this.getQuestionSets().find(q => q.id === id); },

    createQuestionSet(name) {
        const qs = { id: uid('qset'), name, createdAt: Date.now(), questions: [] };
        const list = this.getQuestionSets();
        list.push(qs);
        this.saveQuestionSets(list);
        return qs;
    },

    updateQuestionSet(id, data) {
        const list = this.getQuestionSets();
        const idx = list.findIndex(q => q.id === id);
        if (idx < 0) return;
        list[idx] = { ...list[idx], ...data };
        this.saveQuestionSets(list);
    },

    deleteQuestionSet(id) {
        this.saveQuestionSets(this.getQuestionSets().filter(q => q.id !== id));
    },

    duplicateQuestionSet(id) {
        const src = this.getQuestionSet(id);
        if (!src) return;
        const copy = {
            id: uid('qset'),
            name: src.name + ' (bản sao)',
            createdAt: Date.now(),
            questions: JSON.parse(JSON.stringify(src.questions))
        };
        const list = this.getQuestionSets();
        list.push(copy);
        this.saveQuestionSets(list);
        return copy;
    },

    getHistory() { return IDBStore.cache.history; },
    saveHistory(list) { IDBStore.cache.history = list; IDBStore.persist('history'); },

    saveSessionToHistory(session) {
        if (!session.results) computeRanking(session);
        const avgScore = session.results?.length
            ? Math.round(session.results.reduce((s, r) => s + r.score, 0) / session.results.length)
            : 0;
        const list = this.getHistory();
        list.unshift({
            id: session.id,
            classId: session.classId,
            questionSetId: session.questionSetId,
            className: session.className,
            qsetName: session.qsetName,
            startedAt: session.startedAt,
            completedAt: session.completedAt,
            studentCount: session.students.length,
            questionCount: session.questions.length,
            avgScore,
            students: session.students.map(s => ({ id: s.id, name: s.name, cardNumber: s.cardNumber })),
            questions: session.questions.map(q => ({
                id: q.id,
                question: q.question,
                correctAnswer: q.correctAnswer
            })),
            results: session.results,
            answers: session.answers
        });
        this.saveHistory(list.slice(0, 200));
    }
};

/* ===== QUESTION PARSER ===== */
function parseQuickImport(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    let question = '';
    const answers = [];
    let correctAnswer = 'A';

    for (const line of lines) {
        const ansMatch = line.match(/^([A-Da-d])[.)]\s*(.+)/);
        const correctMatch = line.match(/^(?:đáp án|dap an|answer|correct)[:\s]+([A-Da-d])/i);
        if (correctMatch) {
            correctAnswer = correctMatch[1].toUpperCase();
        } else if (ansMatch) {
            answers.push({ id: ansMatch[1].toUpperCase(), text: ansMatch[2], image: null });
        } else if (!question) {
            question = line;
        } else {
            question += ' ' + line;
        }
    }

    while (answers.length < 4) {
        const id = ['A', 'B', 'C', 'D'][answers.length];
        answers.push({ id, text: '', image: null });
    }

    return {
        id: uid('q'),
        question,
        questionImage: null,
        answers: answers.slice(0, 4),
        correctAnswer: correctAnswer.toUpperCase()
    };
}

/* ===== SYNC ENGINE ===== */
const SyncEngine = {
    peer: null,
    conn: null,
    channel: null,
    isHost: false,
    peerReady: false,
    onMessage: null,
    reconnectTimer: null,

    init() {
        this.channel = new BroadcastChannel('paper-mode-sync');
        this.channel.onmessage = (e) => {
            if (e.data && e.data.type !== 'ping') this._handle(e.data);
        };
        window.addEventListener('storage', (e) => {
            if (e.key && e.key.startsWith('paperModeLive_')) {
                try {
                    const data = JSON.parse(e.newValue);
                    if (data) this._handle(data);
                } catch (_) {}
            }
        });
    },

    _handle(msg) {
        if (this.onMessage) this.onMessage(msg);
    },

    broadcast(msg) {
        msg.timestamp = Date.now();
        // Gửi điện thoại (Vercel) trước — localStorage/BroadcastChannel chỉ dùng cùng máy
        try {
            if (this.conn?.open) this.conn.send(msg);
        } catch (e) {
            console.warn('Peer send', e);
        }
        try {
            this.channel?.postMessage(msg);
            if (appState.session?.id) {
                localStorage.setItem('paperModeLive_' + appState.session.id, JSON.stringify(msg));
            }
        } catch (e) {
            console.warn('Local sync', e);
        }
    },

    pushToScanner(msg) {
        msg.timestamp = Date.now();
        try {
            if (this.conn?.open) this.conn.send(msg);
        } catch (e) {
            console.warn('pushToScanner', e);
        }
    },

    startHost(sessionId, onConnect) {
        this.isHost = true;
        this.peerReady = false;
        this.onConnectCb = onConnect;
        return new Promise((resolve) => {
            let settled = false;
            const done = (ok) => {
                if (settled) return;
                settled = true;
                resolve(ok);
            };
            try {
                this.peer?.destroy();
                this.peer = new Peer('pm-' + sessionId, {
                    debug: 1,
                    config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }
                });
                this.peer.on('open', () => {
                    this.peerReady = true;
                    done(true);
                });
                this.peer.on('error', err => {
                    console.warn('PeerJS host error', err);
                    done(false);
                });
                this.peer.on('connection', (conn) => {
                    this.conn = conn;
                    conn.on('data', (data) => this._handle(data));
                    conn.on('open', () => {
                        if (this.onConnectCb) this.onConnectCb();
                        pushStateToScanner();
                    });
                    conn.on('close', () => {
                        if (appState.session) {
                            appState.session.scannerConnected = false;
                            $('#presenter-disconnect')?.classList.remove('hidden');
                        }
                    });
                });
                setTimeout(() => done(this.peerReady), 12000);
            } catch (e) {
                done(false);
            }
        });
    },

    connectScanner(sessionId) {
        this.isHost = false;
        return new Promise((resolve) => {
            const hostId = 'pm-' + sessionId;
            try {
                this.peer = new Peer(undefined, { debug: 1 });
                this.peer.on('open', () => {
                    const conn = this.peer.connect(hostId, { reliable: true });
                    conn.on('open', () => {
                        this.conn = conn;
                        conn.on('data', (data) => this._handle(data));
                        resolve(true);
                    });
                    conn.on('error', () => resolve(false));
                    setTimeout(() => resolve(false), 8000);
                });
                this.peer.on('error', () => resolve(false));
            } catch {
                resolve(false);
            }
        });
    },

    setHandler(fn) { this.onMessage = fn; },

    send(msg) {
        if (this.isHost) this.broadcast(msg);
        else if (this.conn?.open) this.conn.send(msg);
        else this.broadcast(msg);
    },

    destroy() {
        clearInterval(this.reconnectTimer);
        this.conn?.close();
        this.peer?.destroy();
        this.conn = null;
        this.peer = null;
    }
};

/* ===== SESSION ===== */
function createSession(classId, qsetId) {
    const cls = DataStore.getClass(classId);
    const qset = DataStore.getQuestionSet(qsetId);
    if (!cls || !qset || !qset.questions.length) return null;

    const sessionId = genSessionId();
    return {
        id: sessionId,
        classId,
        questionSetId: qsetId,
        className: cls.name,
        qsetName: qset.name,
        students: cls.students.map(s => ({ ...s })),
        questions: qset.questions.map(q => ({ ...q })),
        currentQuestionIndex: 0,
        status: SESSION_STATUS.WAITING,
        startedAt: Date.now(),
        completedAt: null,
        answers: [],
        scannerConnected: false,
        results: null
    };
}

function getCurrentQuestion(session) {
    return session?.questions?.[session.currentQuestionIndex] || null;
}

function getAnswersForQuestion(session, questionId) {
    return session.answers.filter(a => a.questionId === questionId);
}

function getAnswerKey(session, questionId, studentId) {
    return session.answers.findIndex(
        a => a.sessionId === session.id && a.questionId === questionId && a.studentId === studentId
    );
}

function recordAnswer(session, studentId, cardId, answer) {
    const q = getCurrentQuestion(session);
    if (!q || session.status === SESSION_STATUS.QUESTION_LOCKED ||
        session.status === SESSION_STATUS.QUESTION_RESULT) return { ok: false, reason: 'locked' };

    const existingIdx = getAnswerKey(session, q.id, studentId);
    const record = {
        id: uid('ans'),
        sessionId: session.id,
        questionId: q.id,
        studentId,
        cardId,
        answer,
        isCorrect: null,
        submittedAt: Date.now(),
        lockedAt: null
    };

    let updated = false;
    if (existingIdx >= 0) {
        session.answers[existingIdx] = { ...session.answers[existingIdx], answer, submittedAt: Date.now() };
        updated = true;
    } else {
        session.answers.push(record);
    }

    return { ok: true, updated, record: session.answers[existingIdx >= 0 ? existingIdx : session.answers.length - 1] };
}

function lockQuestion(session) {
    const q = getCurrentQuestion(session);
    if (!q) return;
    session.status = SESSION_STATUS.QUESTION_LOCKED;

    session.answers.forEach(a => {
        if (a.questionId === q.id) {
            a.isCorrect = a.answer === q.correctAnswer;
            a.lockedAt = Date.now();
        }
    });

    session.students.forEach(st => {
        const has = session.answers.some(a => a.questionId === q.id && a.studentId === st.id);
        if (!has) {
            session.answers.push({
                id: uid('ans'),
                sessionId: session.id,
                questionId: q.id,
                studentId: st.id,
                cardId: st.cardId,
                answer: null,
                isCorrect: false,
                status: 'NO_ANSWER',
                submittedAt: null,
                lockedAt: Date.now()
            });
        }
    });

    session.status = SESSION_STATUS.QUESTION_RESULT;
}

function getQuestionStats(session, questionId) {
    const q = session.questions.find(x => x.id === questionId);
    const ans = getAnswersForQuestion(session, questionId);
    const counts = { A: 0, B: 0, C: 0, D: 0, none: 0 };
    ans.forEach(a => {
        if (a.answer && counts[a.answer] !== undefined) counts[a.answer]++;
        else if (a.status === 'NO_ANSWER' || !a.answer) counts.none++;
    });
    return { question: q, counts, answers: ans, total: session.students.length };
}

function finalizeSessionAnswers(session) {
    if (!session?.questions?.length) return;
    if (!session.answers) session.answers = [];

    session.questions.forEach(q => {
        session.students.forEach(st => {
            let a = session.answers.find(x => x.questionId === q.id && x.studentId === st.id);
            if (!a) {
                session.answers.push({
                    id: uid('ans'),
                    sessionId: session.id,
                    questionId: q.id,
                    studentId: st.id,
                    cardId: st.cardId,
                    answer: null,
                    isCorrect: false,
                    status: 'NO_ANSWER',
                    submittedAt: null
                });
                return;
            }
            if (a.answer) {
                a.isCorrect = a.answer === q.correctAnswer;
            } else {
                a.isCorrect = false;
                a.status = 'NO_ANSWER';
            }
        });
    });
}

function computeRanking(session) {
    const total = session.questions.length;
    const rows = session.students.map(st => {
        let correct = 0, wrong = 0, noAnswer = 0;
        let totalTime = 0, answeredCount = 0;

        session.questions.forEach(q => {
            const a = session.answers.find(x => x.questionId === q.id && x.studentId === st.id);
            if (!a || a.status === 'NO_ANSWER' || a.answer === null) {
                noAnswer++;
            } else if (a.isCorrect) {
                correct++;
                if (a.submittedAt) { totalTime += a.submittedAt; answeredCount++; }
            } else {
                wrong++;
            }
        });

        const pct = total ? Math.round((correct / total) * 100) : 0;
        return {
            studentId: st.id,
            name: st.name,
            cardNumber: st.cardNumber,
            correct, wrong, noAnswer,
            total, score: pct,
            avgTime: answeredCount ? totalTime / answeredCount : Infinity
        };
    });

    rows.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (b.correct !== a.correct) return b.correct - a.correct;
        return a.avgTime - b.avgTime;
    });

    rows.forEach((r, i) => r.rank = i + 1);
    session.results = rows;
    return rows;
}

/* ===== ROUTER ===== */
function showAdminShell(show) {
    $('#admin-shell')?.classList.toggle('hidden', !show);
}

function navigateAdmin(viewId) {
    showAdminShell(true);
    $$('.view-full').forEach(v => v.classList.remove('active'));
    $$('.admin-view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-' + viewId)?.classList.add('active');
    $$('.sidebar-item').forEach(b => {
        const nav = b.dataset.nav;
        b.classList.toggle('active', nav === viewId ||
            (viewId === 'class-form' && nav === 'classes') ||
            (viewId === 'qset-form' && nav === 'question-sets') ||
            (viewId === 'session-start' && nav === 'question-sets'));
    });
    const renderers = {
        classes: renderClasses,
        'question-sets': renderQuestionSets,
        history: renderHistory,
        statistics: renderStatistics,
        'print-cards': loadPrintCardsView
    };
    renderers[viewId]?.();
}

function navigateFull(viewId) {
    showAdminShell(false);
    $$('.view').forEach(v => v.classList.remove('active'));
    $$('.admin-view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-' + viewId)?.classList.add('active');
}

function navigate(viewId) {
    if (['connect', 'presenter', 'ranking', 'splash'].includes(viewId)) navigateFull(viewId);
    else navigateAdmin(viewId);
}

/* ===== VIEWS: CLASSES ===== */
function renderClasses() {
    const list = DataStore.getClasses();
    const el = $('#class-list');
    if (!list.length) {
        el.innerHTML = '<p class="subtitle">Chưa có lớp nào. Bấm "+ Tạo lớp mới" để bắt đầu.</p>';
        return;
    }
    el.innerHTML = list.map(c => `
        <div class="class-card">
            <h3>${esc(c.name)}</h3>
            <p class="student-count">${getClassStudentList(c).length} học sinh</p>
            <button class="btn-scan" data-action="scan-class" data-id="${c.id}">📷 Quét</button>
            <div class="class-card-footer">
                <button data-action="edit-class" data-id="${c.id}">✏️ Sửa lớp</button>
                <button class="btn-delete" data-action="delete-class" data-id="${c.id}">🗑 Xóa lớp</button>
            </div>
        </div>
    `).join('');
}

function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

/* ===== IMPORT HỌC SINH ===== */
function parseStudentNamesFromText(text) {
    return text.split(/[\r\n]+/)
        .flatMap(line => line.split(/[,;|\t]+/))
        .map(s => s.trim().replace(/^\d+[.)]\s*/, ''))
        .filter(Boolean);
}

function parseStudentNamesFromRows(rows) {
    const names = [];
    let nameCol = 0;
    let started = false;

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!row || !row.length) continue;
        const cells = row.map(c => String(c ?? '').trim());
        if (!started) {
            const headerIdx = cells.findIndex(c => /^(stt|tt|tên|ten|họ tên|ho ten|name|họ và tên)/i.test(c));
            if (headerIdx >= 0) {
                nameCol = headerIdx === 0 && cells[1] ? 1 : headerIdx;
                started = true;
                continue;
            }
            started = true;
        }
        const val = cells[nameCol] || cells[0] || '';
        const cleaned = val.replace(/^\d+[.)]\s*/, '').trim();
        if (cleaned && !/^(stt|tt|tên|ten|name|họ tên)/i.test(cleaned)) {
            names.push(cleaned);
        }
    }
    return names;
}

async function parseStudentNamesFromFile(file) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (ext === 'txt' || ext === 'csv') {
        const text = await file.text();
        return ext === 'csv'
            ? parseStudentNamesFromRows(text.split(/\r?\n/).map(l => l.split(/[,;\t]/)))
            : parseStudentNamesFromText(text);
    }
    if (ext === 'xlsx' || ext === 'xls') {
        if (typeof XLSX === 'undefined') throw new Error('Thư viện Excel chưa tải xong');
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: 'array' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
        return parseStudentNamesFromRows(rows);
    }
    throw new Error('Định dạng không hỗ trợ — dùng .xlsx, .csv hoặc .txt');
}

function applyImportedStudents(names) {
    const ta = $('#class-students');
    if (!ta || !names.length) return 0;
    const existing = ta.value.trim() ? ta.value.split('\n').map(s => s.trim()).filter(Boolean) : [];
    const merged = [...existing];
    names.forEach(n => {
        if (!merged.some(e => e.toLowerCase() === n.toLowerCase())) merged.push(n);
    });
    ta.value = merged.join('\n');
    syncCardLabels();
    return names.length;
}

/* ===== ẢNH CÂU HỎI / ĐÁP ÁN ===== */
async function readImageFile(file, maxPx = 960) {
    if (!file || !file.type.startsWith('image/')) throw new Error('Chọn file ảnh (JPG, PNG, GIF, WebP)');
    if (file.size > 8 * 1024 * 1024) throw new Error('Ảnh quá lớn (tối đa 8MB)');

    const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });

    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            let w = img.width, h = img.height;
            if (w > maxPx || h > maxPx) {
                if (w >= h) { h = Math.round(h * maxPx / w); w = maxPx; }
                else { w = Math.round(w * maxPx / h); h = maxPx; }
            }
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
            resolve(canvas.toDataURL('image/jpeg', 0.88));
        };
        img.onerror = reject;
        img.src = dataUrl;
    });
}

function bindImageUpload(inputId, previewId, stateObj, stateKey) {
    const input = $(inputId);
    const preview = $(previewId);
    if (!input) return;
    input.onchange = async () => {
        const file = input.files[0];
        if (!file) return;
        try {
            const url = await readImageFile(file);
            stateObj[stateKey] = url;
            if (preview) {
                preview.innerHTML = `<div class="qm-image-preview"><img src="${url}" alt=""><button type="button" class="btn-img-remove">✕ Xóa ảnh</button></div>`;
                preview.querySelector('.btn-img-remove')?.addEventListener('click', () => {
                    stateObj[stateKey] = null;
                    preview.innerHTML = '';
                    input.value = '';
                });
            }
            showToast('Đã tải ảnh');
        } catch (err) {
            showToast(err.message || 'Không tải được ảnh');
        }
        input.value = '';
    };
}

function renderImagePreviewHtml(url, label) {
    if (!url) return '';
    return `<div class="qm-image-preview"><img src="${url}" alt="${esc(label)}"><button type="button" class="btn-img-remove">✕ Xóa ảnh</button></div>`;
}

function wireModalImageRemoves(modalImages) {
    $$('#modal-box .qm-image-preview .btn-img-remove').forEach(btn => {
        btn.onclick = () => {
            const slot = btn.closest('.qm-image-slot');
            if (!slot) return;
            if (slot.id === 'qm-preview-question') modalImages.questionImage = null;
            else modalImages[slot.id.replace('qm-preview-', '')] = null;
            slot.innerHTML = '';
        };
    });
}

/* ===== HUY HIỆU & THỐNG KÊ ===== */
function getStudentBadges(r) {
    const badges = [];
    if (r.score === 100) badges.push({ emoji: '🔥', label: 'Chiến thần 100%' });
    else if (r.score >= 90) badges.push({ emoji: '🌟', label: 'Siêu sao' });
    else if (r.score >= 70) badges.push({ emoji: '⭐', label: 'Giỏi lắm' });
    else if (r.score >= 50) badges.push({ emoji: '💪', label: 'Cố gắng tốt' });
    if (r.noAnswer === 0 && r.total > 0) badges.push({ emoji: '🎯', label: 'Trả lời đủ' });
    if (r.rank === 1) badges.push({ emoji: '👑', label: 'MVP' });
    return badges;
}

function getRankingCheer(avgScore) {
    if (avgScore >= 90) return '🎉 Xuất sắc! Cả lớp đều rất giỏi!';
    if (avgScore >= 75) return '👏 Tuyệt vời! Các em học rất tốt!';
    if (avgScore >= 50) return '💪 Cố lên! Lần sau sẽ giỏi hơn!';
    return '🌱 Mỗi lần chơi là một bước tiến — tiếp tục nhé!';
}

function buildStatsData() {
    const history = DataStore.getHistory();
    const classes = DataStore.getClasses();
    const qsets = DataStore.getQuestionSets();

    const byClass = {};
    const byQset = {};
    const hallOfFame = {};

    history.forEach(h => {
        if (!byClass[h.classId]) {
            byClass[h.classId] = {
                id: h.classId,
                name: h.className,
                sessions: 0,
                totalScore: 0,
                lastPlayed: 0,
                qsets: new Set()
            };
        }
        const bc = byClass[h.classId];
        bc.sessions++;
        bc.totalScore += h.avgScore || 0;
        bc.lastPlayed = Math.max(bc.lastPlayed, h.completedAt || h.startedAt || 0);
        bc.qsets.add(h.qsetName);

        if (!byQset[h.questionSetId]) {
            byQset[h.questionSetId] = {
                id: h.questionSetId,
                name: h.qsetName,
                sessions: 0,
                totalScore: 0,
                lastPlayed: 0,
                classes: new Set()
            };
        }
        const bq = byQset[h.questionSetId];
        bq.sessions++;
        bq.totalScore += h.avgScore || 0;
        bq.lastPlayed = Math.max(bq.lastPlayed, h.completedAt || h.startedAt || 0);
        bq.classes.add(h.className);

        (h.results || []).forEach(r => {
            const key = `${h.classId}::${r.studentId || r.name}`;
            if (!hallOfFame[key]) {
                hallOfFame[key] = {
                    name: r.name,
                    className: h.className,
                    sessions: 0,
                    totalScore: 0,
                    bestScore: 0
                };
            }
            hallOfFame[key].sessions++;
            hallOfFame[key].totalScore += r.score;
            hallOfFame[key].bestScore = Math.max(hallOfFame[key].bestScore, r.score);
        });
    });

    return {
        history,
        classes,
        qsets,
        byClass: Object.values(byClass).map(c => ({
            ...c,
            avgScore: c.sessions ? Math.round(c.totalScore / c.sessions) : 0,
            qsetList: [...c.qsets]
        })).sort((a, b) => b.sessions - a.sessions),
        byQset: Object.values(byQset).map(q => ({
            ...q,
            avgScore: q.sessions ? Math.round(q.totalScore / q.sessions) : 0,
            classList: [...q.classes]
        })).sort((a, b) => b.sessions - a.sessions),
        hallOfFame: Object.values(hallOfFame)
            .map(h => ({ ...h, avgScore: h.sessions ? Math.round(h.totalScore / h.sessions) : 0 }))
            .sort((a, b) => b.bestScore - a.bestScore || b.avgScore - a.avgScore)
            .slice(0, 20)
    };
}

function renderStatistics() {
    const stats = buildStatsData();
    const el = $('#stats-content');
    if (!el) return;

    const totalStudents = stats.classes.reduce((s, c) => s + getClassStudentList(c).length, 0);
    const totalQuestions = stats.qsets.reduce((s, q) => s + (q.questions?.length || 0), 0);

    el.innerHTML = `
        <div class="stats-overview">
            <div class="stat-card stat-pink"><span class="stat-num">${stats.history.length}</span><span class="stat-label">Phiên đã chơi</span></div>
            <div class="stat-card stat-blue"><span class="stat-num">${stats.classes.length}</span><span class="stat-label">Lớp học</span></div>
            <div class="stat-card stat-green"><span class="stat-num">${stats.qsets.length}</span><span class="stat-label">Bộ câu hỏi</span></div>
            <div class="stat-card stat-yellow"><span class="stat-num">${totalStudents}</span><span class="stat-label">Học sinh</span></div>
            <div class="stat-card stat-purple"><span class="stat-num">${totalQuestions}</span><span class="stat-label">Tổng câu hỏi</span></div>
        </div>

        <h3 class="stats-section-title">🏫 Thống kê theo lớp</h3>
        ${stats.byClass.length ? `
            <div class="stats-table-wrap">
                <table class="stats-table">
                    <thead><tr><th>Lớp</th><th>Phiên chơi</th><th>Điểm TB</th><th>Bộ đã dùng</th><th>Lần cuối</th></tr></thead>
                    <tbody>${stats.byClass.map(c => `
                        <tr>
                            <td><strong>${esc(c.name)}</strong></td>
                            <td>${c.sessions}</td>
                            <td><span class="score-pill">${c.avgScore}%</span></td>
                            <td>${c.qsetList.map(esc).join(', ') || '—'}</td>
                            <td>${c.lastPlayed ? new Date(c.lastPlayed).toLocaleDateString('vi-VN') : '—'}</td>
                        </tr>
                    `).join('')}</tbody>
                </table>
            </div>` : '<p class="subtitle">Chưa có phiên nào — hãy chơi thử!</p>'}

        <h3 class="stats-section-title">📋 Thống kê theo bộ câu hỏi</h3>
        ${stats.byQset.length ? `
            <div class="stats-table-wrap">
                <table class="stats-table">
                    <thead><tr><th>Bộ câu hỏi</th><th>Lần chơi</th><th>Điểm TB lớp</th><th>Lớp đã dùng</th><th>Lần cuối</th></tr></thead>
                    <tbody>${stats.byQset.map(q => `
                        <tr>
                            <td><strong>${esc(q.name)}</strong></td>
                            <td>${q.sessions}</td>
                            <td><span class="score-pill">${q.avgScore}%</span></td>
                            <td>${q.classList.map(esc).join(', ') || '—'}</td>
                            <td>${q.lastPlayed ? new Date(q.lastPlayed).toLocaleDateString('vi-VN') : '—'}</td>
                        </tr>
                    `).join('')}</tbody>
                </table>
            </div>` : '<p class="subtitle">Chưa có dữ liệu bộ câu hỏi.</p>'}

        <h3 class="stats-section-title">🏆 Bảng vinh danh (xuyên suốt các phiên)</h3>
        ${stats.hallOfFame.length ? `
            <div class="hall-of-fame">${stats.hallOfFame.map((h, i) => `
                <div class="fame-item">
                    <span class="fame-rank">${i < 3 ? ['🥇', '🥈', '🥉'][i] : i + 1}</span>
                    <div class="fame-info">
                        <strong>${esc(h.name)}</strong>
                        <span>${esc(h.className)} · ${h.sessions} phiên · TB ${h.avgScore}% · Cao nhất ${h.bestScore}%</span>
                    </div>
                </div>
            `).join('')}</div>` : '<p class="subtitle">Chơi vài phiên để có bảng vinh danh!</p>'}

        <h3 class="stats-section-title">📅 Lịch sử chi tiết</h3>
        ${stats.history.length ? `
            <div class="stats-history-list">${stats.history.slice(0, 30).map(h => `
                <div class="stats-history-item">
                    <div class="stats-history-main">
                        <strong>${esc(h.className)}</strong> × <em>${esc(h.qsetName)}</em>
                    </div>
                    <div class="stats-history-meta">
                        ${h.studentCount || '?'} HS · ${h.questionCount || '?'} câu · TB ${h.avgScore || 0}%
                        · ${new Date(h.completedAt || h.startedAt).toLocaleString('vi-VN')}
                    </div>
                    <button class="btn btn-secondary btn-sm" data-action="view-history" data-id="${h.id}">Xem kết quả</button>
                </div>
            `).join('')}</div>` : ''}
    `;
}

function openClassForm(classId = null) {
    appState.editingClassId = classId;
    $('#class-form-title').textContent = classId ? '🏫 Sửa lớp' : '🏫 Tạo lớp mới';
    $('#btn-save-class').textContent = classId ? 'LƯU LỚP' : 'TẠO LỚP';
    if (classId) {
        const c = DataStore.getClass(classId);
        $('#class-name').value = c.name;
        $('#class-students').value = c.students.map(s => s.name).join('\n');
    } else {
        $('#class-form').reset();
        $('#class-students').value = '';
    }
    syncCardLabels();
    bindStudentEditorScroll();
    navigateAdmin('class-form');
}

function getClassStudentList(cls) {
    return (cls?.students || []).filter(st => String(st.name || '').trim());
}

let printCardsLoadId = 0;

function setupPrintClassSelect() {
    const sel = $('#print-class-select');
    const classes = DataStore.getClasses();
    if (!sel) return null;
    sel.innerHTML = classes.length
        ? classes.map(c => `<option value="${c.id}">${esc(c.name)} (${getClassStudentList(c).length} HS)</option>`).join('')
        : '<option value="">— Chưa có lớp —</option>';
    const id = appState.printClassId || appState.currentClassId || classes[0]?.id;
    if (id && classes.some(c => c.id === id)) sel.value = id;
    return sel.value || id;
}

function loadPrintCardsView() {
    const classId = setupPrintClassSelect();
    if (classId) renderPrintCards(classId);
    else {
        $('#print-class-name').textContent = 'Chưa có lớp nào';
        $('#cards-preview').innerHTML = '<p class="subtitle">Tạo lớp và thêm học sinh trước.</p>';
        $('#cards-loading')?.classList.add('hidden');
    }
}

async function renderPrintCards(classId) {
    const loadId = ++printCardsLoadId;
    const cls = DataStore.getClass(classId);
    if (!cls) return;

    appState.printClassId = classId;
    const students = getClassStudentList(cls);

    $('#print-class-name').textContent =
        `${cls.name} — ${students.length} thẻ / ${students.length} học sinh`;
    $('#cards-loading')?.classList.remove('hidden');
    const container = $('#cards-preview');
    container.innerHTML = '';

    if (!students.length) {
        $('#cards-loading')?.classList.add('hidden');
        container.innerHTML = '<p class="subtitle">Lớp chưa có học sinh — thêm tên trong Quản lý lớp.</p>';
        return;
    }

    const fragment = document.createDocumentFragment();
    for (const st of students) {
        if (loadId !== printCardsLoadId) return;

        const card = document.createElement('div');
        card.className = 'answer-card answer-card-preview';
        card.innerHTML = `
            <div class="card-num-label">Thẻ ${st.cardNumber}</div>
            <div class="card-dir-top">A</div>
            <div class="card-middle-row">
                <span class="card-dir-side card-rot-d">D</span>
                <div class="card-marker"></div>
                <span class="card-dir-side card-rot-b">B</span>
            </div>
            <div class="card-dir-bottom card-rot-c">C</div>
            <div class="card-name">${esc(st.name)}</div>
            <button type="button" class="btn-print-card-pdf" data-action="print-card-pdf" data-class-id="${classId}" data-student-id="${st.id}">📄 In PDF</button>
        `;
        const cv = document.createElement('canvas');
        card.querySelector('.card-marker').appendChild(cv);
        MarkerUtil.drawPreview(cv, st.cardNumber);
        fragment.appendChild(card);
    }

    if (loadId !== printCardsLoadId) return;
    container.appendChild(fragment);
    $('#cards-loading')?.classList.add('hidden');
}

function buildCardSheetHtml(st) {
    return `
        <div class="print-sheet-single">
            <div class="card-num-label">Thẻ ${st.cardNumber}</div>
            <div class="card-dir-top">A</div>
            <div class="card-middle-row">
                <span class="card-dir-side card-rot-d">D</span>
                <div class="card-marker"></div>
                <span class="card-dir-side card-rot-b">B</span>
            </div>
            <div class="card-dir-bottom card-rot-c">C</div>
            <div class="card-name">${esc(st.name)}</div>
        </div>`;
}

async function renderPrintCardCanvas(st, scale = 4) {
    const markerPx = 120 * scale;
    const pad = 20 * scale;
    const w = markerPx + pad * 5;
    const h = markerPx + pad * 7;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = '#444';
    ctx.font = `600 ${11 * scale}px Segoe UI, sans-serif`;
    ctx.textAlign = 'left';
    ctx.fillText(`Thẻ ${st.cardNumber}`, pad, pad + 11 * scale);

    ctx.fillStyle = '#000';
    ctx.font = `800 ${22 * scale}px Segoe UI, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('A', w / 2, pad + 36 * scale);

    const mc = document.createElement('canvas');
    await MarkerUtil.drawAsync(mc, st.cardNumber, st.cardId);
    const mx = (w - markerPx) / 2;
    const my = pad + 44 * scale;
    ctx.drawImage(mc, mx, my, markerPx, markerPx);

    ctx.font = `800 ${18 * scale}px Segoe UI, sans-serif`;
    ctx.save();
    ctx.translate(pad + 10 * scale, my + markerPx / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('D', 0, 0);
    ctx.restore();
    ctx.save();
    ctx.translate(w - pad - 10 * scale, my + markerPx / 2);
    ctx.rotate(Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('B', 0, 0);
    ctx.restore();

    ctx.save();
    ctx.translate(w / 2, my + markerPx + 28 * scale);
    ctx.rotate(Math.PI);
    ctx.textAlign = 'center';
    ctx.fillText('C', 0, 0);
    ctx.restore();

    ctx.font = `600 ${10 * scale}px Segoe UI, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(st.name, w / 2, h - pad);

    return canvas;
}

function pdfFileName(st) {
    const num = String(st.cardNumber).padStart(2, '0');
    const name = (st.name || 'hoc-sinh').normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .slice(0, 40) || 'hoc-sinh';
    return `The-${num}-${name}.pdf`;
}

async function downloadCardPdf(classId, studentId) {
    const cls = DataStore.getClass(classId);
    const st = cls?.students.find(s => s.id === studentId);
    if (!st) {
        showToast('Không tìm thấy học sinh');
        return;
    }

    try {
        const canvas = await renderPrintCardCanvas(st);
        const img = canvas.toDataURL('image/jpeg', 0.92);

        if (window.jspdf?.jsPDF) {
            const { jsPDF } = window.jspdf;
            const pdf = new jsPDF({ unit: 'mm', format: [70, 90], orientation: 'portrait' });
            pdf.addImage(img, 'JPEG', 0, 0, 70, 90);
            pdf.save(pdfFileName(st));
            showToast(`Đã tải PDF — Thẻ ${st.cardNumber}: ${st.name}`);
            return;
        }
    } catch (e) {
        console.warn('PDF export', e);
    }

    await printCardSheet(classId, studentId);
    showToast('Chọn "Lưu thành PDF" trong hộp thoại in');
}

async function printCardSheet(classId, studentId) {
    const cls = DataStore.getClass(classId);
    const st = cls?.students.find(s => s.id === studentId);
    if (!st) return;

    const area = $('#print-area');
    area.innerHTML = buildCardSheetHtml(st);
    const slot = area.querySelector('.card-marker');
    const cv = document.createElement('canvas');
    slot.appendChild(cv);
    await MarkerUtil.drawAsync(cv, st.cardNumber, st.cardId);
    window.print();
}

/* ===== VIEWS: QUESTION SETS ===== */
function renderQuestionSets() {
    const list = DataStore.getQuestionSets();
    const el = $('#qset-list');
    if (!list.length) {
        el.innerHTML = '<p class="subtitle">Chưa có bộ câu hỏi. Bấm "+ Tạo bộ mới".</p>';
        return;
    }
    el.innerHTML = list.map(q => `
        <div class="class-card">
            <h3>📚 ${esc(q.name)}</h3>
            <p class="student-count">${q.questions.length} câu</p>
            <button class="btn-scan" data-action="play-qset" data-id="${q.id}">▶ Chơi</button>
            <div class="class-card-footer">
                <button data-action="edit-qset" data-id="${q.id}">✏️ Sửa</button>
                <button data-action="dup-qset" data-id="${q.id}">📋 Nhân bản</button>
                <button class="btn-delete" data-action="delete-qset" data-id="${q.id}">🗑 Xóa</button>
            </div>
        </div>
    `).join('');
}

function openQSetForm(qsetId = null) {
    appState.editingQSetId = qsetId;
    if (!qsetId) {
        const qs = DataStore.createQuestionSet('Bộ câu hỏi mới');
        appState.editingQSetId = qs.id;
    }
    const qs = DataStore.getQuestionSet(appState.editingQSetId);
    $('#qset-form-title').textContent = 'Bộ: ' + qs.name;
    $('#qset-name').value = qs.name;
    renderQuestionEditor();
    navigateAdmin('qset-form');
}

function renderQuestionEditor() {
    const qs = DataStore.getQuestionSet(appState.editingQSetId);
    if (!qs) return;
    const el = $('#question-list');
    el.innerHTML = qs.questions.map((q, i) => `
        <div class="q-item" data-qidx="${i}">
            <div class="q-item-header">
                <span class="q-item-num">Câu ${i + 1}${q.questionImage ? ' 📷' : ''}</span>
                <div class="q-item-actions">
                    <button class="btn btn-ghost btn-sm" data-action="edit-q" data-idx="${i}">Sửa</button>
                    <button class="btn btn-ghost btn-sm" data-action="del-q" data-idx="${i}">Xóa</button>
                </div>
            </div>
            <div class="q-item-preview" id="q-preview-${i}"></div>
            ${q.questionImage ? `<div class="q-item-thumb"><img src="${q.questionImage}" alt=""></div>` : ''}
        </div>
    `).join('');
    qs.questions.forEach((q, i) => _renderTextOrLatex(q.question, $(`#q-preview-${i}`)));
}

function openQuestionModal(qIdx = null) {
    const qs = DataStore.getQuestionSet(appState.editingQSetId);
    const q = qIdx !== null ? qs.questions[qIdx] : {
        id: uid('q'), question: '', questionImage: null,
        answers: [
            { id: 'A', text: '', image: null },
            { id: 'B', text: '', image: null },
            { id: 'C', text: '', image: null },
            { id: 'D', text: '', image: null }
        ],
        correctAnswer: 'A'
    };

    const modalImages = {
        questionImage: q.questionImage || null,
        A: q.answers[0]?.image || null,
        B: q.answers[1]?.image || null,
        C: q.answers[2]?.image || null,
        D: q.answers[3]?.image || null
    };

    showModal(`
        <h3>${qIdx !== null ? 'Sửa câu hỏi' : 'Thêm câu hỏi'}</h3>
        <div class="qm-field">
            <div class="qm-field-header"><label>Câu hỏi</label>
                <button type="button" class="formula-btn" data-formula-target="qm-question">Σ</button></div>
            <textarea id="qm-question" rows="3">${esc(q.question)}</textarea>
            <div class="qm-live-preview"></div>
            <label class="qm-upload-btn">📷 Tải ảnh câu hỏi<input type="file" id="qm-img-question" accept="image/*" class="hidden"></label>
            <div id="qm-preview-question" class="qm-image-slot">${renderImagePreviewHtml(modalImages.questionImage, 'Câu hỏi')}</div>
        </div>
        ${['A', 'B', 'C', 'D'].map((id, i) => `
            <div class="qm-field qm-field-answer qm-ans-${id.toLowerCase()}">
                <div class="qm-field-header"><label>Đáp án ${id}</label>
                    <button type="button" class="formula-btn" data-formula-target="qm-ans-${id}">Σ</button></div>
                <textarea id="qm-ans-${id}" rows="2">${esc(q.answers[i]?.text || '')}</textarea>
                <div class="qm-live-preview"></div>
                <label class="qm-upload-btn">🖼 Ảnh đáp án ${id}<input type="file" id="qm-img-${id}" accept="image/*" class="hidden"></label>
                <div id="qm-preview-${id}" class="qm-image-slot">${renderImagePreviewHtml(modalImages[id], 'Đáp án ' + id)}</div>
            </div>
        `).join('')}
        <label>Đáp án đúng</label>
        <select id="qm-correct">
            ${['A', 'B', 'C', 'D'].map(id => `<option value="${id}" ${q.correctAnswer === id ? 'selected' : ''}>${id}</option>`).join('')}
        </select>
        <div class="modal-actions">
            <button class="btn btn-ghost" id="modal-cancel">Hủy</button>
            <button class="btn btn-primary" id="modal-save-q">Lưu</button>
        </div>
    `);

    $$('#modal-box textarea').forEach(ta => {
        updateLivePreview(ta);
        ta.addEventListener('input', () => updateLivePreview(ta));
    });

    bindImageUpload('#qm-img-question', '#qm-preview-question', modalImages, 'questionImage');
    ['A', 'B', 'C', 'D'].forEach(id => bindImageUpload(`#qm-img-${id}`, `#qm-preview-${id}`, modalImages, id));
    wireModalImageRemoves(modalImages);

    $('#modal-cancel').onclick = hideModal;
    $('#modal-save-q').onclick = () => {
        const updated = {
            id: q.id,
            question: $('#qm-question').value,
            questionImage: modalImages.questionImage,
            answers: ['A', 'B', 'C', 'D'].map(id => ({
                id,
                text: $(`#qm-ans-${id}`).value,
                image: modalImages[id]
            })),
            correctAnswer: $('#qm-correct').value
        };
        const questions = [...qs.questions];
        if (qIdx !== null) questions[qIdx] = updated;
        else questions.push(updated);
        DataStore.updateQuestionSet(appState.editingQSetId, { questions });
        hideModal();
        renderQuestionEditor();
        showToast('Đã lưu câu hỏi');
    };

    $$('.formula-btn').forEach(btn => {
        btn.onclick = () => openFormulaBuilder($('#' + btn.dataset.formulaTarget));
    });
}

function openQuickImport() {
    showModal(`
        <h3>⚡ Nhập nhanh</h3>
        <p class="subtitle">Dán câu hỏi theo mẫu A. B. C. D. và Đáp án: B</p>
        <textarea id="quick-import-text" rows="12" placeholder="Tính 2 + 3 = ?&#10;A. 4&#10;B. 5&#10;C. 6&#10;D. 7&#10;Đáp án: B"></textarea>
        <div class="modal-actions">
            <button class="btn btn-ghost" id="modal-cancel">Hủy</button>
            <button class="btn btn-primary" id="modal-parse">✨ Phân tích</button>
        </div>
    `);
    $('#modal-cancel').onclick = hideModal;
    $('#modal-parse').onclick = () => {
        const parsed = parseQuickImport($('#quick-import-text').value);
        showModal(`
            <h3>Kiểm tra trước khi lưu</h3>
            <div class="qm-live-preview" id="parse-preview-q"></div>
            <p><strong>Đáp án đúng:</strong> ${parsed.correctAnswer}</p>
            ${parsed.answers.map(a => `<p>${a.id}. ${esc(a.text)}</p>`).join('')}
            <div class="modal-actions">
                <button class="btn btn-ghost" id="modal-cancel2">Quay lại</button>
                <button class="btn btn-primary" id="modal-confirm-parse">Lưu câu hỏi</button>
            </div>
        `);
        _renderTextOrLatex(parsed.question, $('#parse-preview-q'));
        $('#modal-cancel2').onclick = openQuickImport;
        $('#modal-confirm-parse').onclick = () => {
            const qs = DataStore.getQuestionSet(appState.editingQSetId);
            DataStore.updateQuestionSet(appState.editingQSetId, { questions: [...qs.questions, parsed] });
            hideModal();
            renderQuestionEditor();
            showToast('Đã thêm câu hỏi');
        };
    };
}

/* ===== FORMULA BUILDER ===== */
function openFormulaBuilder(targetInput) {
    let latex = '';
    const groups = {
        'Phân số': () => {
            showFormulaFields('Tử số', 'Mẫu số', (a, b) => `\\frac{${a || 'a'}}{${b || 'b'}}`);
        },
        'Lũy thừa': () => showFormulaFields('Cơ số', 'Số mũ', (a, b) => `${a || 'x'}^{${b || 'n'}}`),
        'Căn bậc hai': () => showFormulaFields('Biểu thức', '', (a) => `\\sqrt{${a || 'x'}}`),
        'Tổng': () => { latex = '\\sum_{i=1}^{n}'; updatePreview(); },
        'Tích phân': () => { latex = '\\int_{a}^{b}'; updatePreview(); }
    };

    function updatePreview() {
        const box = $('#formula-preview');
        if (box) _renderTextOrLatex('$' + latex + '$', box);
        const raw = $('#formula-latex-raw');
        if (raw) raw.value = latex;
    }

    function showFormulaFields(l1, l2, build) {
        $('#formula-fields').innerHTML = `
            <div class="formula-input-row"><label>${l1}</label><input id="ff-a"></div>
            ${l2 ? `<div class="formula-input-row"><label>${l2}</label><input id="ff-b"></div>` : ''}
            <button class="btn btn-sm btn-secondary" id="ff-build">Tạo</button>
        `;
        $('#ff-build').onclick = () => {
            latex = build($('#ff-a')?.value, $('#ff-b')?.value);
            updatePreview();
        };
    }

    showModal(`
        <h3>Công thức toán Σ</h3>
        <div class="formula-groups">
            ${Object.keys(groups).map(g => `<button class="formula-group-btn" data-fg="${g}">${g}</button>`).join('')}
        </div>
        <div id="formula-fields"></div>
        <div class="formula-preview-box" id="formula-preview"></div>
        <label>LaTeX</label>
        <input id="formula-latex-raw" placeholder="\\frac{a}{b}">
        <div class="symbol-grid">
            ${['+', '-', '\\times', '\\div', '=', '\\neq', '\\leq', '\\geq', '\\pm', '\\infty', '\\pi', '\\sqrt{x}', '\\sum', '\\int', '\\rightarrow'].map(s =>
                `<button class="symbol-btn" data-sym="${s}">${s.replace(/\\\\/g, '')}</button>`
            ).join('')}
        </div>
        <div class="modal-actions">
            <button class="btn btn-ghost" id="fm-cancel">Hủy</button>
            <button class="btn btn-primary" id="fm-insert">Thêm</button>
        </div>
    `);

    $$('[data-fg]').forEach(b => b.onclick = () => groups[b.dataset.fg]());
    $$('[data-sym]').forEach(b => b.onclick = () => {
        latex += b.dataset.sym;
        updatePreview();
    });
    $('#formula-latex-raw')?.addEventListener('input', e => { latex = e.target.value; updatePreview(); });
    $('#fm-cancel').onclick = hideModal;
    $('#fm-insert').onclick = () => {
        const wrapped = latex.includes('$') ? latex : `$${latex}$`;
        const pos = targetInput.selectionStart || targetInput.value.length;
        targetInput.value = targetInput.value.slice(0, pos) + wrapped + targetInput.value.slice(pos);
        updateLivePreview(targetInput);
        hideModal();
    };
}

/* ===== SESSION FLOW ===== */
function openSessionStart(qsetId) {
    if (!appState.currentClassId) {
        showToast('Chọn lớp trước (bấm Quét trên card lớp)');
        navigateAdmin('classes');
        return;
    }
    const cls = DataStore.getClass(appState.currentClassId);
    const qs = DataStore.getQuestionSet(qsetId);
    if (!qs?.questions.length) { showToast('Bộ câu hỏi trống'); return; }

    appState.currentQSetId = qsetId;
    $('#ss-class').textContent = cls.name;
    $('#ss-students').textContent = cls.students.length;
    $('#ss-questions').textContent = qs.questions.length;
    $('#ss-qset').textContent = qs.name;
    navigateAdmin('session-start');
}

function showConnectScreen(session) {
    const url = getScannerUrl(session.id);
    const code = getShortSessionCode(session.id);

    $('#connect-meta').textContent = `${session.className} · ${session.questions.length} câu · ${session.students.length} học sinh`;
    $('#connect-link').value = url;
    $('#display-session-id').textContent = code;

    renderConnectQr(url);

    const status = $('#connect-status');
    status.className = 'connect-status-bar waiting';
    status.innerHTML = '<span class="spinner"></span> Đang chờ điện thoại quét QR...';

    navigateFull('connect');
}

async function startSessionFlow() {
    const btn = $('#btn-start-session');
    if (btn?.disabled) return;

    const session = createSession(appState.currentClassId, appState.currentQSetId);
    if (!session) {
        showToast('Không tạo được phiên — chọn lớp và bộ câu hỏi có ít nhất 1 câu');
        return;
    }

    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Đang mở mã QR...';
    }

    appState.session = session;
    appState.role = 'presenter';
    SyncEngine.setHandler(handleSyncMessage);

    // Hiện QR ngay — không chờ PeerJS (trước đây treo 10–12 giây, trông như không có gì)
    showConnectScreen(session);

    SyncEngine.startHost(session.id, () => onScannerConnected()).then(hostOk => {
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'Bắt đầu phiên';
        }
        if (!hostOk) {
            showToast('Chưa tạo được kênh realtime — dùng Chrome/Edge + internet');
            const status = $('#connect-status');
            if (status) {
                status.innerHTML = '⚠ Chưa kết nối PeerJS — vẫn quét QR được, thử lại sau vài giây';
            }
        } else {
            SyncEngine.broadcast({ type: 'SESSION_CREATED', session: getSessionSnapshot() });
        }
    });
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
        results: s.results,
        scannerConnected: s.scannerConnected,
        startedAt: s.startedAt, completedAt: s.completedAt
    }));
}

function pushStateToScanner() {
    if (!appState.session) return;
    SyncEngine.pushToScanner({ type: 'STATE_SYNC', session: getSessionSnapshot() });
}

function onScannerConnected() {
    if (!appState.session) return;
    if (appState.session._phoneHandled) {
        pushStateToScanner();
        return;
    }
    appState.session._phoneHandled = true;

    appState.session.scannerConnected = true;
    appState.session.status = SESSION_STATUS.CONNECTED;
    $('#presenter-disconnect')?.classList.add('hidden');

    const status = $('#connect-status');
    if (status) {
        status.className = 'connect-status-bar connected';
        status.textContent = '🟢 Điện thoại đã kết nối — đang mở câu hỏi...';
    }

    beginQuestion();
    pushStateToScanner();
}

function beginQuestion() {
    const s = appState.session;
    if (!s) return;
    s.status = SESSION_STATUS.QUESTION_ACTIVE;
    const snap = getSessionSnapshot();
    SyncEngine.pushToScanner({ type: 'QUESTION_CHANGED', session: snap });
    SyncEngine.broadcast({ type: 'QUESTION_CHANGED', session: snap });
    renderPresenter();
}

function handleSyncMessage(msg) {
    if (!msg?.type) return;

    if (appState.role === 'presenter') {
        if (msg.type === 'SCANNER_CONNECTED') {
            onScannerConnected();
        } else if (msg.type === 'ANSWER_SCANNED' || msg.type === 'ANSWER_UPDATED') {
            if (msg.session) mergeSession(msg.session);
            else applyRemoteAnswer(msg);
            renderPresenter();
            playSound('scan');
        } else if (['LOCK_QUESTION', 'NEXT_QUESTION', 'END_SESSION', 'REQUEST_STATE'].includes(msg.type)) {
            handlePresenterCommand(msg);
        } else if (msg.type === 'SESSION_COMPLETED') {
            if (appState.session?.status === SESSION_STATUS.COMPLETED) {
                renderRanking(appState.session);
                return;
            }
            if (msg.session) Object.assign(appState.session, msg.session);
            endSession(true);
        }
    }

    if (msg.type === 'REQUEST_STATE' && appState.role === 'presenter') {
        pushStateToScanner();
    }
}

function handlePresenterCommand(msg) {
    const s = appState.session;
    if (!s) return;

    if (msg.type === 'LOCK_QUESTION') {
        lockQuestion(s);
        SyncEngine.broadcast({ type: 'QUESTION_LOCKED', session: getSessionSnapshot() });
        SyncEngine.broadcast({ type: 'QUESTION_RESULT', session: getSessionSnapshot() });
        renderPresenter();
        playSound('lock');
    } else if (msg.type === 'NEXT_QUESTION') {
        if (s.currentQuestionIndex >= s.questions.length - 1) {
            endSession(true);
            return;
        }
        s.currentQuestionIndex++;
        s.status = SESSION_STATUS.QUESTION_ACTIVE;
        SyncEngine.broadcast({ type: 'NEXT_QUESTION', session: getSessionSnapshot() });
        SyncEngine.broadcast({ type: 'QUESTION_CHANGED', session: getSessionSnapshot() });
        renderPresenter();
        playSound('next');
    } else if (msg.type === 'END_SESSION') {
        endSession(true);
    } else if (msg.type === 'REQUEST_STATE') {
        SyncEngine.send({ type: 'STATE_SYNC', session: getSessionSnapshot() });
    }
}

function mergeSession(data) {
    if (!data || !appState.session) return;
    Object.assign(appState.session, data);
    if (appState.session.status === SESSION_STATUS.COMPLETED) return;
    renderPresenter();
}

function applyRemoteAnswer(msg) {
    const s = appState.session;
    if (!s || !msg.studentId || !msg.answer) return;
    const q = getCurrentQuestion(s);
    if (!q) return;
    if (!s.answers) s.answers = [];
    const st = s.students.find(x => x.id === msg.studentId);
    recordAnswer(s, msg.studentId, st?.cardId || msg.cardId, msg.answer);
    appState.lastScannedStudentId = msg.studentId;
    clearTimeout(applyRemoteAnswer._flashT);
    applyRemoteAnswer._flashT = setTimeout(() => { appState.lastScannedStudentId = null; }, 800);
}

/* ===== PRESENTER UI ===== */
function renderPresenter() {
    const s = appState.session;
    if (!s) return;

    navigateFull('presenter');

    const q = getCurrentQuestion(s);
    if (!q) {
        $('#pres-question-title').textContent = '';
        $('#pres-question-text').textContent = 'Chưa có câu hỏi';
        return;
    }

    const answered = getAnswersForQuestion(s, q.id).filter(a => a.answer).length;
    const total = s.students.length;
    const pending = total - answered;
    const pct = total ? Math.round((answered / total) * 100) : 0;

    $('#pres-class-badge').textContent = s.className;

    const liveEl = $('#pres-scanner-live');
    if (liveEl) {
        if (s.scannerConnected) {
            liveEl.classList.remove('hidden');
            liveEl.textContent = pending > 0
                ? `📱 Đang quét · còn ${pending} HS`
                : '📱 Đã quét đủ — sẵn sàng chốt';
        } else {
            liveEl.classList.add('hidden');
        }
    }

    $('#pres-question-title').textContent = q ? `CÂU ${s.currentQuestionIndex + 1}` : '';
    $('#pres-answered').textContent = `${answered}/${total} đã quét`;
    $('#pres-progress-fill').style.width = pct + '%';
    document.documentElement.style.setProperty('--pres-font', (appState.presenterFontSize / 16) + 'rem');
    $('#pres-font-size').textContent = appState.presenterFontSize;

    const isResult = s.status === SESSION_STATUS.QUESTION_RESULT;
    $('#presenter-body').classList.toggle('hidden', isResult);
    $('#presenter-result').classList.toggle('hidden', !isResult);

    if (isResult) {
        renderPresenterResult(s, q);
        renderPresenterSidebar(s, q);
        return;
    }

    const qTextEl = $('#pres-question-text');
    qTextEl.textContent = '';
    _renderTextOrLatex(q.question, qTextEl);
    $('#pres-question-image').innerHTML = q.questionImage ? `<img src="${q.questionImage}" alt="">` : '';

    $('#pres-answers').innerHTML = q.answers.map(a => `
        <div class="pres-answer-card" data-answer="${a.id}">
            <div class="pres-answer-letter">${a.id}</div>
            <div class="pres-answer-content"></div>
        </div>
    `).join('');
    q.answers.forEach(a => {
        const box = $(`.pres-answer-card[data-answer="${a.id}"] .pres-answer-content`);
        if (a.image) box.innerHTML = `<img src="${a.image}" alt="">`;
        else _renderTextOrLatex(a.text, box);
    });

    renderPresenterSidebar(s, q);
}

function renderPresenterSidebar(s, q) {
    const list = $('#pres-student-list');
    const pendingEl = $('#pres-pending-label');
    if (!list) return;

    const rows = s.students.map(st => {
        const a = s.answers.find(x => x.questionId === q?.id && x.studentId === st.id && x.answer);
        return { st, a, done: !!a };
    });

    rows.sort((x, y) => {
        if (x.done !== y.done) return x.done ? 1 : -1;
        return (x.st.cardNumber || 0) - (y.st.cardNumber || 0);
    });

    const pending = rows.filter(r => !r.done).length;
    if (pendingEl) pendingEl.textContent = pending > 0 ? `⏳ Còn ${pending} chưa quét` : '✅ Đã quét đủ';

    list.innerHTML = rows.map(({ st, a, done }) => `
        <div class="pres-student-item ${done ? 'scanned' : 'pending'}${st.id === appState.lastScannedStudentId ? ' just-scanned' : ''}">
            <span class="pres-student-name" title="Thẻ ${st.cardNumber}">${esc(st.name)}</span>
            <span class="pres-student-ans">${a ? a.answer : '—'}</span>
        </div>
    `).join('');
}

function renderPresenterResult(s, q) {
    const stats = getQuestionStats(s, q.id);
    const max = Math.max(1, ...Object.values(stats.counts));
    $('#pres-correct-banner').textContent = `✓ ĐÁP ÁN ĐÚNG: ${q.correctAnswer}`;
    $('#pres-result-bars').innerHTML = ['A', 'B', 'C', 'D'].map(id => {
        const n = stats.counts[id] || 0;
        const pct = Math.round((n / max) * 100);
        const isCorrect = id === q.correctAnswer;
        return `
            <div class="result-bar-row">
                <span class="result-bar-label">${id}${isCorrect ? ' ✓' : ''}</span>
                <div class="result-bar-track"><div class="result-bar-fill ${isCorrect ? 'correct-fill' : ''}" style="width:${pct}%"></div></div>
                <span>${n}</span>
            </div>`;
    }).join('');

    $$('.pres-answer-card').forEach(el => {
        el.classList.toggle('correct', el.dataset.answer === q.correctAnswer);
    });

    if (window.confetti) confetti({ particleCount: 80, spread: 60, origin: { y: 0.6 } });
    playSound('correct');
}

/* ===== RANKING ===== */
function endSession(fromSync = false) {
    const s = appState.session;
    if (!s) return;
    if (s._ended) {
        renderRanking(s);
        return;
    }
    s._ended = true;

    finalizeSessionAnswers(s);
    s.status = SESSION_STATUS.COMPLETED;
    s.completedAt = Date.now();
    computeRanking(s);
    DataStore.saveSessionToHistory(s);

    SyncEngine.broadcast({ type: 'SESSION_COMPLETED', session: getSessionSnapshot() });
    setTimeout(() => SyncEngine.destroy(), 600);

    renderRanking(s);
    playSound('complete');
}

function confirmEndSession() {
    const s = appState.session;
    const completed = s.currentQuestionIndex + (s.status === SESSION_STATUS.QUESTION_RESULT ? 1 : 0);
    showModal(`
        <h3>🛑 Kết thúc phiên?</h3>
        <p>${s.students.length} học sinh · ${s.questions.length} câu hỏi</p>
        <p>Đã hoàn thành ~${completed} câu</p>
        <div class="modal-actions">
            <button class="btn btn-ghost" id="me-cancel">Hủy</button>
            <button class="btn btn-danger" id="me-ok">Kết thúc</button>
        </div>
    `);
    $('#me-cancel').onclick = hideModal;
    $('#me-ok').onclick = () => {
        hideModal();
        endSession();
    };
}

/* ===== RANKING ===== */
function renderRanking(session) {
    const rows = session.results || computeRanking(session);
    navigateFull('ranking');
    appState.analyticsSession = session;

    const avgScore = rows.length ? Math.round(rows.reduce((s, r) => s + r.score, 0) / rows.length) : 0;
    const qCount = session.questions?.length || session.questionCount || rows[0]?.total || 0;
    const stCount = session.students?.length || session.studentCount || rows.length;

    $('#rank-meta').textContent = `${session.className} · ${session.qsetName} · ${qCount} câu · ${stCount} học sinh`;
    const cheerEl = $('#rank-cheer');
    if (cheerEl) cheerEl.textContent = getRankingCheer(avgScore);

    const podium = rows.slice(0, 3);
    const medals = ['gold', 'silver', 'bronze'];
    const icons = ['🥇', '🥈', '🥉'];
    $('#rank-podium').innerHTML = podium.map((r, i) => {
        const badges = getStudentBadges({ ...r, rank: i + 1 });
        return `
        <div class="podium-item ${medals[i]}">
            <div class="podium-medal">${icons[i]}${i === 0 ? '<span class="mvp-crown">👑</span>' : ''}</div>
            <div class="podium-name">${esc(r.name)}</div>
            <div class="podium-badges">${badges.map(b => `<span class="rank-badge" title="${esc(b.label)}">${b.emoji}</span>`).join('')}</div>
            <div class="podium-score">${r.correct}/${r.total} · ${r.score}%</div>
        </div>`;
    }).join('');

    $('#rank-table tbody').innerHTML = rows.map(r => {
        const badges = getStudentBadges(r);
        return `
        <tr class="${r.rank <= 3 ? 'rank-top-' + r.rank : ''}">
            <td>${r.rank <= 3 ? ['🥇', '🥈', '🥉'][r.rank - 1] : r.rank}</td>
            <td>${esc(r.name)} ${badges.map(b => `<span class="rank-badge-sm" title="${esc(b.label)}">${b.emoji}</span>`).join('')}</td>
            <td>${r.correct}</td>
            <td>${r.wrong}</td>
            <td>${r.noAnswer}</td>
            <td>${r.correct}/${r.total}</td>
            <td><strong>${r.score}%</strong></td>
        </tr>`;
    }).join('');

    if (window.confetti) setTimeout(() => confetti({ particleCount: 150, spread: 100, origin: { y: 0.4 } }), 300);
}

/* ===== ANALYTICS ===== */
function renderAnalytics(session) {
    if (!session) session = appState.analyticsSession;
    if (!session) return;
    navigateAdmin('analytics');

    const stPanel = $('#analytics-students');
    stPanel.innerHTML = (session.results || computeRanking(session)).map(r => {
        const details = session.questions.map((q, i) => {
            const a = session.answers.find(x => x.questionId === q.id && x.studentId === r.studentId);
            let cls = 'no-answer', icon = '○';
            if (a?.answer) {
                cls = a.isCorrect ? 'correct' : 'wrong';
                icon = a.isCorrect ? '✓' : '✗';
            }
            return `<div class="q-row ${cls}">Câu ${i + 1} ${icon}${a?.answer ? ' → ' + a.answer : ''}${!a?.isCorrect && a?.answer ? ' (đúng: ' + q.correctAnswer + ')' : ''}</div>`;
        }).join('');
        return `
            <div class="student-analytic" data-student="${r.studentId}">
                <strong>${esc(r.name)}</strong> — ${r.correct}/${session.questions.length} (${r.score}%)
                <div class="student-detail hidden" id="sd-${r.studentId}">${details}</div>
            </div>`;
    }).join('');

    stPanel.querySelectorAll('.student-analytic').forEach(el => {
        el.onclick = () => $(`#sd-${el.dataset.student}`)?.classList.toggle('hidden');
    });

    const qPanel = $('#analytics-questions');
    qPanel.innerHTML = session.questions.map((q, i) => {
        const stats = getQuestionStats(session, q.id);
        const correct = stats.answers.filter(a => a.isCorrect).length;
        return `
            <div class="question-analytic">
                <strong>Câu ${i + 1}</strong> — Đúng: ${correct} / ${session.students.length}
                <div class="q-detail">${['A', 'B', 'C', 'D'].map(id =>
                    `<div>${id}${id === q.correctAnswer ? ' ✓' : ''}: ${stats.counts[id] || 0}</div>`
                ).join('')}</div>
            </div>`;
    }).join('');
}

function renderHistory() {
    const list = DataStore.getHistory();
    const el = $('#history-list');
    if (!list.length) {
        el.innerHTML = '<p class="subtitle">Chưa có lịch sử phiên.</p>';
        return;
    }
    el.innerHTML = list.map(h => `
        <div class="class-card">
            <h3>${esc(h.className)}</h3>
            <p class="student-count">${esc(h.qsetName)} · ${h.results?.length || 0} học sinh</p>
            <p class="student-count">${new Date(h.completedAt || h.startedAt).toLocaleDateString('vi-VN')}</p>
            <button class="btn-scan" data-action="view-history" data-id="${h.id}">Xem kết quả</button>
        </div>
    `).join('');
}

function renderSplash() {}

/* ===== EVENT BINDINGS ===== */
function bindEvents() {
    document.body.addEventListener('click', e => {
        const nav = e.target.closest('[data-nav]');
        if (nav) { e.preventDefault(); navigate(nav.dataset.nav); return; }

        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const { action, id } = btn.dataset;
        const idx = btn.dataset.idx;

        switch (action) {
            case 'scan-class':
                appState.currentClassId = id;
                navigateAdmin('question-sets');
                break;
            case 'select-class':
                appState.currentClassId = id;
                navigateAdmin('question-sets');
                break;
            case 'edit-class': openClassForm(id); break;
            case 'delete-class':
                if (confirm('Xóa lớp này?')) { DataStore.deleteClass(id); renderClasses(); }
                break;
            case 'print-cards':
                appState.printClassId = id;
                navigateAdmin('print-cards');
                break;
            case 'print-card-pdf':
                downloadCardPdf(btn.dataset.classId, btn.dataset.studentId);
                break;
            case 'play-qset': openSessionStart(id); break;
            case 'edit-qset':
                appState.editingQSetId = id;
                openQSetForm(id);
                break;
            case 'dup-qset':
                DataStore.duplicateQuestionSet(id);
                renderQuestionSets();
                showToast('Đã nhân bản');
                break;
            case 'delete-qset':
                if (confirm('Xóa bộ câu hỏi?')) { DataStore.deleteQuestionSet(id); renderQuestionSets(); }
                break;
            case 'edit-q': openQuestionModal(parseInt(idx)); break;
            case 'del-q': {
                const qs = DataStore.getQuestionSet(appState.editingQSetId);
                qs.questions.splice(parseInt(idx), 1);
                DataStore.updateQuestionSet(appState.editingQSetId, { questions: qs.questions });
                renderQuestionEditor();
                break;
            }
            case 'view-history': {
                const h = DataStore.getHistory().find(x => x.id === id);
                if (h) {
                    appState.analyticsSession = h;
                    renderRanking({
                        ...h,
                        students: h.students || h.results?.map(r => ({ id: r.studentId, name: r.name })) || [],
                        questions: h.questions || []
                    });
                }
                break;
            }
        }
    });

    $('#btn-enter-app')?.addEventListener('click', () => navigateAdmin('classes'));

    $$('.sidebar-item').forEach(item => {
        item.addEventListener('click', () => navigateAdmin(item.dataset.nav));
    });

    $('#class-students')?.addEventListener('input', syncCardLabels);
    bindStudentEditorScroll();

    $('#btn-import-students')?.addEventListener('click', () => $('#file-import-students')?.click());
    $('#file-import-students')?.addEventListener('change', async e => {
        const file = e.target.files[0];
        if (!file) return;
        try {
            const names = await parseStudentNamesFromFile(file);
            if (!names.length) { showToast('Không tìm thấy tên trong file'); return; }
            const added = applyImportedStudents(names);
            showToast(`Đã thêm ${added} tên từ file`);
        } catch (err) {
            showToast(err.message || 'Không đọc được file');
        }
        e.target.value = '';
    });

    $('#btn-add-class')?.addEventListener('click', () => openClassForm());
    $('#class-form')?.addEventListener('submit', e => {
        e.preventDefault();
        const name = $('#class-name').value.trim();
        const names = $('#class-students').value.split('\n');
        if (appState.editingClassId) {
            DataStore.updateClass(appState.editingClassId, name, names);
            appState.printClassId = appState.editingClassId;
        } else {
            const cls = DataStore.createClass(name, names);
            appState.printClassId = cls.id;
        }
        navigateAdmin('classes');
        showToast('Đã lưu lớp');
    });

    $('#print-class-select')?.addEventListener('change', e => {
        appState.printClassId = e.target.value;
        renderPrintCards(e.target.value);
    });

    $('#btn-add-qset')?.addEventListener('click', () => openQSetForm());
    $('#qset-meta-form')?.addEventListener('submit', e => {
        e.preventDefault();
        DataStore.updateQuestionSet(appState.editingQSetId, { name: $('#qset-name').value.trim() });
        $('#qset-form-title').textContent = 'Bộ: ' + $('#qset-name').value;
        showToast('Đã lưu tên bộ');
    });
    $('#btn-add-question')?.addEventListener('click', () => openQuestionModal());
    $('#btn-quick-import')?.addEventListener('click', openQuickImport);
    $('#btn-import-json')?.addEventListener('click', () => $('#file-import-json').click());
    $('#btn-export-json')?.addEventListener('click', () => {
        const qs = DataStore.getQuestionSet(appState.editingQSetId);
        const blob = new Blob([JSON.stringify(qs, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = (qs.name || 'questions') + '.json';
        a.click();
    });
    $('#file-import-json')?.addEventListener('change', e => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const data = JSON.parse(reader.result);
                if (data.questions) DataStore.updateQuestionSet(appState.editingQSetId, { questions: data.questions, name: data.name || undefined });
                renderQuestionEditor();
                showToast('Đã nhập JSON');
            } catch { showToast('File JSON không hợp lệ'); }
        };
        reader.readAsText(file);
        e.target.value = '';
    });

    $('#btn-start-session')?.addEventListener('click', startSessionFlow);
    $('#btn-copy-link')?.addEventListener('click', () => {
        const v = $('#connect-link')?.value || '';
        if (!v) return;
        navigator.clipboard?.writeText(v);
        showToast('Đã sao chép link quét');
    });

    $('#btn-font-down')?.addEventListener('click', () => {
        appState.presenterFontSize = Math.max(18, appState.presenterFontSize - 2);
        renderPresenter();
    });
    $('#btn-font-up')?.addEventListener('click', () => {
        appState.presenterFontSize = Math.min(56, appState.presenterFontSize + 2);
        renderPresenter();
    });
    $('#btn-pres-prev')?.addEventListener('click', () => {
        if (appState.session?.currentQuestionIndex > 0) {
            appState.session.currentQuestionIndex--;
            appState.session.status = SESSION_STATUS.QUESTION_ACTIVE;
            SyncEngine.broadcast({ type: 'QUESTION_CHANGED', session: getSessionSnapshot() });
            renderPresenter();
        }
    });
    $('#btn-pres-next')?.addEventListener('click', () => {
        SyncEngine.send({ type: 'NEXT_QUESTION' });
    });
    $('#btn-pres-end')?.addEventListener('click', confirmEndSession);
    $('#btn-reconnect-phone')?.addEventListener('click', () => {
        if (appState.session) {
            appState.session._phoneHandled = false;
            showConnectScreen(appState.session);
        }
    });

    $('#btn-fullscreen')?.addEventListener('click', () => {
        if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
        else document.exitFullscreen?.();
        document.body.classList.toggle('presenter-fullscreen');
    });

    $('#btn-analyze-session')?.addEventListener('click', () => renderAnalytics(appState.analyticsSession));
    $('#btn-back-home')?.addEventListener('click', () => {
        appState.session = null;
        appState.role = null;
        navigateAdmin('classes');
    });
    $('#btn-analytics-back')?.addEventListener('click', () => navigateFull('ranking'));

    $$('.analytics-tabs .tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            $$('.analytics-tabs .tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            $('#analytics-students').classList.toggle('hidden', btn.dataset.tab !== 'students');
            $('#analytics-questions').classList.toggle('hidden', btn.dataset.tab !== 'questions');
        });
    });

    $('#modal-overlay')?.addEventListener('click', e => {
        if (e.target === $('#modal-overlay')) hideModal();
    });
}

/* ===== INIT ===== */
function seedDemoData() {
    if (DataStore.getClasses().length) return;
    const demo = DataStore.createClass('Lớp 6B (demo)', [
        'Nguyễn Minh Khang', 'Đặng Quốc Khánh', 'Giàng Thị Lan', 'Hầu Văn Linh', 'Trần Thu Hà'
    ]);
    const qs = DataStore.createQuestionSet('Ôn tập Toán lớp 6');
    DataStore.updateQuestionSet(qs.id, {
        questions: [
            {
                id: uid('q'), question: 'Tính $2 + 3$', questionImage: null,
                answers: [
                    { id: 'A', text: '4', image: null },
                    { id: 'B', text: '5', image: null },
                    { id: 'C', text: '6', image: null },
                    { id: 'D', text: '7', image: null }
                ],
                correctAnswer: 'B'
            },
            {
                id: uid('q'), question: 'Giải phương trình $x^2 - 4 = 0$', questionImage: null,
                answers: [
                    { id: 'A', text: '$x = 2$', image: null },
                    { id: 'B', text: '$x = \\pm 2$', image: null },
                    { id: 'C', text: '$x = 4$', image: null },
                    { id: 'D', text: '$x = 0$', image: null }
                ],
                correctAnswer: 'B'
            }
        ]
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    try {
        await IDBStore.init();
    } catch (err) {
        console.error('IndexedDB init failed:', err);
        showToast('Không mở được bộ nhớ — thử tải lại trang');
    }

    SyncEngine.init();
    bindEvents();
    seedDemoData();

    const settings = getSettings();
    appState.soundEnabled = settings.soundEnabled !== false;

    navigateFull('splash');
});
