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

function loadJSON(key, fallback) {
    try {
        const v = localStorage.getItem(key);
        return v ? JSON.parse(v) : fallback;
    } catch {
        return fallback;
    }
}

function saveJSON(key, data) {
    localStorage.setItem(key, JSON.stringify(data));
}

function getSettings() {
    return loadJSON(STORAGE.SETTINGS, { soundEnabled: true, countNoAnswerAsWrong: false });
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

    if (!url || url.startsWith('file:')) {
        placeholder?.classList.remove('hidden');
        return;
    }
    placeholder?.classList.add('hidden');

    if (window.QRCode) {
        QRCode.toCanvas(document.createElement('canvas'), url, { width: 180, margin: 2, errorCorrectionLevel: 'M' }, (err, canvas) => {
            if (!err && canvas) {
                qrBox.appendChild(canvas);
            } else {
                const img = document.createElement('img');
                img.alt = 'QR';
                img.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(url)}`;
                qrBox.appendChild(img);
            }
        });
    } else {
        const img = document.createElement('img');
        img.alt = 'QR';
        img.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(url)}`;
        qrBox.appendChild(img);
    }
}

/* ===== MARKER (Plickers-style) ===== */
const MarkerUtil = {
    getGrid(cardNumber) {
        const grid = Array.from({ length: 7 }, () => Array(7).fill(0));
        for (let i = 0; i < 7; i++) {
            grid[0][i] = grid[6][i] = grid[i][0] = grid[i][6] = 1;
        }
        let seed = cardNumber * 7919 + 104729;
        for (let r = 1; r < 6; r++) {
            for (let c = 1; c < 6; c++) {
                seed = (seed * 1103515245 + 12345) & 0x7fffffff;
                grid[r][c] = (seed % 3) !== 0 ? 1 : 0;
            }
        }
        grid[1][1] = grid[1][5] = grid[5][1] = 1;
        grid[5][5] = 0;
        return grid;
    },

    draw(canvas, cardNumber, cardId) {
        const size = 120;
        const cell = size / 7;
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, size, size);
        const grid = this.getGrid(cardNumber);
        for (let r = 0; r < 7; r++) {
            for (let c = 0; c < 7; c++) {
                if (grid[r][c]) {
                    ctx.fillStyle = '#000';
                    ctx.fillRect(c * cell + 1, r * cell + 1, cell - 2, cell - 2);
                }
            }
        }
        if (window.QRCode && cardId) {
            const tmp = document.createElement('canvas');
            QRCode.toCanvas(tmp, cardId, { width: 36, margin: 0 }, () => {
                ctx.drawImage(tmp, (size - 36) / 2, (size - 36) / 2, 36, 36);
            });
        }
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

/* ===== DATA STORE ===== */
const DataStore = {
    getClasses() { return loadJSON(STORAGE.CLASSES, []); },
    saveClasses(list) { saveJSON(STORAGE.CLASSES, list); },

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
            const existing = old.students[i];
            if (existing && existing.name === name.trim()) return existing;
            return {
                id: existing?.id || uid('student'),
                name: name.trim(),
                classId: id,
                cardId: existing?.cardId || genCardId(),
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

    getQuestionSets() { return loadJSON(STORAGE.QSETS, []); },
    saveQuestionSets(list) { saveJSON(STORAGE.QSETS, list); },

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

    getHistory() { return loadJSON(STORAGE.HISTORY, []); },
    saveHistory(list) { saveJSON(STORAGE.HISTORY, list); },

    saveSessionToHistory(session) {
        const list = this.getHistory();
        list.unshift({
            id: session.id,
            classId: session.classId,
            questionSetId: session.questionSetId,
            className: session.className,
            qsetName: session.qsetName,
            startedAt: session.startedAt,
            completedAt: session.completedAt,
            results: session.results,
            answers: session.answers
        });
        this.saveHistory(list.slice(0, 100));
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
        this.channel?.postMessage(msg);
        if (appState.session?.id) {
            localStorage.setItem('paperModeLive_' + appState.session.id, JSON.stringify(msg));
        }
        if (this.conn?.open) this.conn.send(msg);
    },

    startHost(sessionId, onConnect) {
        this.isHost = true;
        this.onMessage = null;
        return new Promise((resolve, reject) => {
            try {
                this.peer = new Peer('pm-' + sessionId, {
                    debug: 1,
                    config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }
                });
                this.peer.on('open', () => resolve());
                this.peer.on('error', err => {
                    console.warn('PeerJS host error, fallback BroadcastChannel', err);
                    resolve();
                });
                this.peer.on('connection', (conn) => {
                    this.conn = conn;
                    conn.on('open', () => {
                        if (onConnect) onConnect();
                        conn.on('data', (data) => this._handle(data));
                    });
                });
            } catch (e) {
                resolve();
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
        'print-cards': renderPrintCardsPage
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
            <p class="student-count">${c.students.length} học sinh</p>
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

function renderPrintCardsPage() {
    const sel = $('#print-class-select');
    const classes = DataStore.getClasses();
    sel.innerHTML = classes.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    const id = appState.printClassId || appState.currentClassId || classes[0]?.id;
    if (id) {
        sel.value = id;
        renderPrintCards(id);
    }
    sel.onchange = () => renderPrintCards(sel.value);
    navigateAdmin('print-cards');
}

async function renderPrintCards(classId) {
    const cls = DataStore.getClass(classId);
    if (!cls) return;
    appState.printClassId = classId;
    $('#print-class-name').textContent = cls.name + ' — ' + cls.students.length + ' thẻ';
    const container = $('#cards-preview');
    container.innerHTML = '';

    for (const st of cls.students) {
        const card = document.createElement('div');
        card.className = 'answer-card';
        card.innerHTML = `
            <div class="card-num-label">Thẻ số ${st.cardNumber}</div>
            <div class="card-dir-top">A</div>
            <div class="card-middle-row">
                <span class="card-dir-side" style="transform:rotate(-90deg)">D</span>
                <div class="card-marker"></div>
                <span class="card-dir-side" style="transform:rotate(90deg)">B</span>
            </div>
            <div class="card-dir-bottom">C</div>
            <div class="card-name">${esc(st.name)}</div>
        `;
        container.appendChild(card);
        const cv = document.createElement('canvas');
        card.querySelector('.card-marker').appendChild(cv);
        MarkerUtil.draw(cv, st.cardNumber, st.cardId);
    }
}

function printAllCards() {
    const area = $('#print-area');
    area.innerHTML = $('#cards-preview').innerHTML;
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
                <span class="q-item-num">Câu ${i + 1}</span>
                <div class="q-item-actions">
                    <button class="btn btn-ghost btn-sm" data-action="edit-q" data-idx="${i}">Sửa</button>
                    <button class="btn btn-ghost btn-sm" data-action="del-q" data-idx="${i}">Xóa</button>
                </div>
            </div>
            <div class="q-item-preview" id="q-preview-${i}"></div>
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

    showModal(`
        <h3>${qIdx !== null ? 'Sửa câu hỏi' : 'Thêm câu hỏi'}</h3>
        <div class="qm-field">
            <div class="qm-field-header"><label>Câu hỏi</label>
                <button type="button" class="formula-btn" data-formula-target="qm-question">Σ</button></div>
            <textarea id="qm-question" rows="3">${esc(q.question)}</textarea>
            <div class="qm-live-preview"></div>
        </div>
        ${['A', 'B', 'C', 'D'].map((id, i) => `
            <div class="qm-field">
                <div class="qm-field-header"><label>Đáp án ${id}</label>
                    <button type="button" class="formula-btn" data-formula-target="qm-ans-${id}">Σ</button></div>
                <textarea id="qm-ans-${id}" rows="2">${esc(q.answers[i]?.text || '')}</textarea>
                <div class="qm-live-preview"></div>
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

    $('#modal-cancel').onclick = hideModal;
    $('#modal-save-q').onclick = () => {
        const updated = {
            id: q.id,
            question: $('#qm-question').value,
            questionImage: null,
            answers: ['A', 'B', 'C', 'D'].map(id => ({ id, text: $(`#qm-ans-${id}`).value, image: null })),
            correctAnswer: $('#qm-correct').value
        };
        const questions = [...qs.questions];
        if (qIdx !== null) questions[qIdx] = updated;
        else questions.push(updated);
        DataStore.updateQuestionSet(appState.editingQSetId, { questions });
        hideModal();
        renderQuestionEditor();
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
    $('#connect-code-inline') && ($('#connect-code-inline').textContent = code);
    $('#display-session-id').textContent = code;
    $('#connect-scanner-base') && ($('#connect-scanner-base').textContent = PaperModeConfig.getScannerBaseUrl());

    const baseInput = $('#connect-base-url');
    if (baseInput) baseInput.value = PaperModeConfig.getScannerBaseUrl();

    renderConnectQr(url);

    const status = $('#connect-status');
    status.className = 'connect-status-bar waiting';
    status.innerHTML = '<span class="spinner"></span> Đang chờ điện thoại quét QR và kết nối...';

    navigateFull('connect');
}

async function startSessionFlow() {
    const session = createSession(appState.currentClassId, appState.currentQSetId);
    if (!session) { showToast('Không tạo được phiên'); return; }

    appState.session = session;
    appState.role = 'presenter';

    await SyncEngine.startHost(session.id, () => onScannerConnected());
    SyncEngine.setHandler(handleSyncMessage);

    SyncEngine.broadcast({ type: 'SESSION_CREATED', session: getSessionSnapshot() });

    showConnectScreen(session);
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

function onScannerConnected() {
    if (!appState.session) return;
    appState.session.scannerConnected = true;
    appState.session.status = SESSION_STATUS.CONNECTED;
    const status = $('#connect-status');
    if (status) {
        status.className = 'connect-status-bar connected';
        status.textContent = '🟢 Điện thoại đã kết nối';
    }
    SyncEngine.send({ type: 'STATE_SYNC', session: getSessionSnapshot() });
    setTimeout(() => beginQuestion(), 800);
}

function beginQuestion() {
    const s = appState.session;
    if (!s) return;
    s.status = SESSION_STATUS.QUESTION_ACTIVE;
    SyncEngine.broadcast({ type: 'QUESTION_CHANGED', session: getSessionSnapshot() });
    renderPresenter();
}

function handleSyncMessage(msg) {
    if (!msg?.type) return;

    if (appState.role === 'presenter') {
        if (msg.type === 'SCANNER_CONNECTED') {
            onScannerConnected();
        } else if (msg.type === 'ANSWER_SCANNED' || msg.type === 'ANSWER_UPDATED') {
            if (msg.session) mergeSession(msg.session);
            else renderPresenter();
        } else if (['LOCK_QUESTION', 'NEXT_QUESTION', 'END_SESSION', 'REQUEST_STATE'].includes(msg.type)) {
            handlePresenterCommand(msg);
        } else if (msg.type === 'SESSION_COMPLETED') {
            if (msg.session) mergeSession(msg.session);
            endSession(true);
        }
    }

    if (msg.type === 'REQUEST_STATE' && appState.role === 'presenter') {
        SyncEngine.send({ type: 'STATE_SYNC', session: getSessionSnapshot() });
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
    renderPresenter();
}

/* ===== PRESENTER UI ===== */
function renderPresenter() {
    const s = appState.session;
    if (!s) return;

    navigateFull('presenter');

    const q = getCurrentQuestion(s);
    const answered = getAnswersForQuestion(s, q?.id).filter(a => a.answer).length;
    const total = s.students.length;
    const pct = total ? Math.round((answered / total) * 100) : 0;

    $('#pres-class-badge').textContent = s.className;
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
    if (!list) return;
    list.innerHTML = s.students.map(st => {
        const a = s.answers.find(x => x.questionId === q?.id && x.studentId === st.id && x.answer);
        return `<div class="pres-student-item ${a ? 'scanned' : ''}" title="#${st.cardNumber} ${esc(st.name)}">${esc(st.name)}</div>`;
    }).join('');
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

    s.status = SESSION_STATUS.COMPLETED;
    s.completedAt = Date.now();
    computeRanking(s);
    DataStore.saveSessionToHistory(s);

    SyncEngine.broadcast({ type: 'SESSION_COMPLETED', session: getSessionSnapshot() });

    SyncEngine.destroy();

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

    $('#rank-meta').textContent = `${session.className} · ${session.qsetName} · ${session.questions.length} câu · ${session.students.length} học sinh`;
    appState.analyticsSession = session;

    const podium = rows.slice(0, 3);
    const medals = ['gold', 'silver', 'bronze'];
    const icons = ['🥇', '🥈', '🥉'];
    $('#rank-podium').innerHTML = podium.map((r, i) => `
        <div class="podium-item ${medals[i]}">
            <div class="podium-medal">${icons[i]}</div>
            <div class="podium-name">${esc(r.name)}</div>
            <div class="podium-score">${r.correct}/${r.total} · ${r.score}%</div>
        </div>
    `).join('');

    $('#rank-table tbody').innerHTML = rows.map(r => `
        <tr>
            <td>${r.rank}</td>
            <td>${esc(r.name)}</td>
            <td>${r.correct}</td>
            <td>${r.wrong}</td>
            <td>${r.noAnswer}</td>
            <td>${r.score}</td>
            <td>${r.score}%</td>
        </tr>
    `).join('');

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
                renderPrintCardsPage();
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
                    renderRanking({ ...h, students: h.results?.map(r => ({ id: r.studentId, name: r.name })) || [], questions: [] });
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

    $('#btn-add-class')?.addEventListener('click', () => openClassForm());
    $('#class-form')?.addEventListener('submit', e => {
        e.preventDefault();
        const name = $('#class-name').value.trim();
        const names = $('#class-students').value.split('\n');
        if (appState.editingClassId) DataStore.updateClass(appState.editingClassId, name, names);
        else DataStore.createClass(name, names);
        navigateAdmin('classes');
        showToast('Đã lưu lớp');
    });

    $('#btn-print-all')?.addEventListener('click', printAllCards);
    $('#btn-pdf-cards')?.addEventListener('click', printAllCards);

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

    $('#btn-save-base-url')?.addEventListener('click', () => {
        const v = $('#connect-base-url')?.value.trim();
        if (!v || !v.startsWith('http')) {
            showToast('Nhập URL Vercel, ví dụ https://che-do-giay-scanner.vercel.app');
            return;
        }
        PaperModeConfig.saveScannerBaseUrl(v);
        showToast('Đã lưu URL app quét');
        if (appState.session) showConnectScreen(appState.session);
    });

    $('#btn-open-scanner-tab')?.addEventListener('click', () => {
        if (!appState.session) return;
        window.open(getScannerUrl(appState.session.id), '_blank');
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
        if (appState.session) showConnectScreen(appState.session);
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

document.addEventListener('DOMContentLoaded', () => {
    SyncEngine.init();
    bindEvents();
    seedDemoData();

    const settings = getSettings();
    appState.soundEnabled = settings.soundEnabled !== false;

    navigateFull('splash');
});
