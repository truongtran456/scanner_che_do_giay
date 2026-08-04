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
    cameraReady: false
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
                    conn.on('open', () => {
                        this.conn = conn;
                        conn.on('data', (data) => this._handle(data));
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
        this.conn?.close();
        this.peer?.destroy();
        this.conn = null;
        this.peer = null;
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
        showView('ended');
        return;
    }

    if (s.questions?.length) {
        if (!appState.cameraReady) startCamera();
        else renderScanner();
        showView('scanner');
    } else {
        $('#wait-status').textContent = 'Đã kết nối — chờ giáo viên bắt đầu câu hỏi...';
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

/* ===== CARD SCANNER ===== */
const CardScanner = {
    stream: null,
    rafId: null,
    lastScan: {},

    async start(videoEl, canvasEl) {
        try {
            this.stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
            });
            videoEl.srcObject = this.stream;
            await videoEl.play();
            this._loop(videoEl, canvasEl);
            appState.cameraReady = true;
            return true;
        } catch (e) {
            showToast('Không mở được camera: ' + e.message);
            return false;
        }
    },

    stop() {
        cancelAnimationFrame(this.rafId);
        this.stream?.getTracks().forEach(t => t.stop());
        this.stream = null;
        this.lastScan = {};
        appState.cameraReady = false;
    },

    _loop(video, canvas) {
        const ctx = canvas.getContext('2d');
        const tick = () => {
            if (!this.stream) return;
            if (video.readyState === video.HAVE_ENOUGH_DATA) {
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                ctx.drawImage(video, 0, 0);
                const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
                const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
                if (code?.data) this._process(code);
            }
            this.rafId = requestAnimationFrame(tick);
        };
        tick();
    },

    _process(code) {
        const data = code.data.trim();
        let cardId = null;
        if (data.startsWith('CARD-')) cardId = data.split('|')[0];
        else {
            try {
                const j = JSON.parse(data);
                cardId = j.card || j.cardId;
            } catch (_) {}
        }
        if (!cardId) {
            $('#scan-hint')?.classList.remove('hidden');
            $('#scan-hint').textContent = 'Không nhận diện thẻ — đưa mã QR vào khung';
            return;
        }
        $('#scan-hint')?.classList.add('hidden');

        const orientation = this._getOrientation(code.location);
        const key = cardId + orientation;
        const now = Date.now();
        if (this.lastScan[key] && now - this.lastScan[key] < 1500) return;
        this.lastScan[key] = now;
        onCardScanned(cardId, orientation);
    },

    _getOrientation(loc) {
        const dx = loc.topRightCorner.x - loc.topLeftCorner.x;
        const dy = loc.topRightCorner.y - loc.topLeftCorner.y;
        let angle = Math.atan2(dy, dx) * 180 / Math.PI;
        angle = ((angle % 360) + 360) % 360;
        if (angle >= 315 || angle < 45) return 'A';
        if (angle >= 45 && angle < 135) return 'B';
        if (angle >= 135 && angle < 225) return 'C';
        return 'D';
    }
};

function onCardScanned(cardId, orientation) {
    const s = appState.session;
    if (!s?.students?.length) return;
    if (s.status === SESSION_STATUS.QUESTION_LOCKED || s.status === SESSION_STATUS.QUESTION_RESULT) return;

    const student = s.students.find(st => st.cardId === cardId);
    if (!student) {
        showScanToast('Không tìm thấy học sinh cho thẻ này', false);
        return;
    }

    const result = recordAnswer(s, student.id, cardId, orientation);
    if (!result.ok) return;

    const eventType = result.updated ? 'ANSWER_UPDATED' : 'ANSWER_SCANNED';
    SyncEngine.send({ type: eventType, session: getSessionSnapshot(), studentId: student.id, answer: orientation });

    const tag = $('#scan-student-tag');
    tag.textContent = student.name;
    tag.classList.remove('hidden');
    clearTimeout(showScanToast._tagT);
    showScanToast._tagT = setTimeout(() => tag.classList.add('hidden'), 2000);

    showScanToast(
        result.updated
            ? `↻ ${student.name}\nĐã cập nhật: ${orientation}`
            : `✓ ${student.name}\nThẻ ${String(student.cardNumber).padStart(2, '0')}\nChọn: ${orientation}`,
        !result.updated
    );
    playSound('scan');
    renderScanner();
}

function showScanToast(text, success = true) {
    const el = $('#scan-toast');
    el.textContent = text;
    el.classList.remove('hidden', 'update');
    if (!success) el.classList.add('update');
    clearTimeout(showScanToast._t);
    showScanToast._t = setTimeout(() => el.classList.add('hidden'), 1200);
}

function renderScanner() {
    const s = appState.session;
    if (!s?.questions?.length) return;

    const q = getCurrentQuestion(s);
    const answered = getAnswersForQuestion(s, q?.id).filter(a => a.answer);
    const isResult = s.status === SESSION_STATUS.QUESTION_RESULT;

    $('#scan-q-pill').textContent = `📋 Câu ${s.currentQuestionIndex + 1}/${s.questions.length}`;
    $('#scan-count-pill').textContent = `✓ ${answered.length}/${s.students.length}`;
    $('#scan-answered-count').textContent = `${answered.length}/${s.students.length} đã trả lời`;

    $('#scanner-active').classList.toggle('hidden', isResult);
    $('#scanner-result').classList.toggle('hidden', !isResult);

    $('#scanner-answered-list').innerHTML = s.students.map(st => {
        const a = s.answers.find(x => x.questionId === q?.id && x.studentId === st.id);
        const done = a?.answer;
        return `<span class="answered-chip ${done ? '' : 'pending'}">${done ? '✓' : '○'} ${esc(st.name)}${done ? ' (' + a.answer + ')' : ''}</span>`;
    }).join('');

    if (isResult && q) {
        const stats = getQuestionStats(s, q.id);
        $('#scan-result-header').innerHTML = `
            <p>📝 Câu ${s.currentQuestionIndex + 1} / ${s.questions.length}</p>
            <p>✓ ${answered.length} / ${s.students.length} đã trả lời</p>
            <p style="color:var(--green);font-weight:700;">✓ Đáp án đúng: ${q.correctAnswer}</p>`;
        const max = Math.max(1, ...['A', 'B', 'C', 'D'].map(id => stats.counts[id] || 0));
        $('#scan-result-bars').innerHTML = ['A', 'B', 'C', 'D'].map(id => {
            const n = stats.counts[id] || 0;
            return `<div class="result-bar-row"><span class="result-bar-label">${id}</span>
                <div class="result-bar-track"><div class="result-bar-fill" style="width:${Math.round(n / max * 100)}%"></div></div>
                <span>${n}</span></div>`;
        }).join('');
    }
}

async function startCamera() {
    const video = $('#scanner-video');
    const canvas = $('#scanner-canvas');
    await CardScanner.start(video, canvas);
    renderScanner();
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
                SyncEngine.send({ type: 'SCANNER_CONNECTED', from: 'scanner' });
                SyncEngine.send({ type: 'REQUEST_STATE' });
                $('#wait-status').textContent = 'Đã kết nối lại';
            }
        }
    }, 5000);
}

async function init(sessionId) {
    appState.sessionId = sessionId;
    appState.session = { id: sessionId, status: SESSION_STATUS.WAITING, students: [], questions: [], answers: [] };

    $('#wait-session').textContent = getShortSessionCode(sessionId);
    showView('waiting');

    SyncEngine.onMessage = handleSyncMessage;

    const connected = await SyncEngine.connectScanner(sessionId);
    if (connected) {
        SyncEngine.send({ type: 'SCANNER_CONNECTED', from: 'scanner' });
        SyncEngine.send({ type: 'REQUEST_STATE' });
        $('#wait-status').textContent = 'Đã kết nối — chờ dữ liệu từ máy chiếu...';
    } else {
        $('#wait-status').textContent = 'Chưa kết nối được — đảm bảo giáo viên đã mở phiên trên máy tính';
        showToast('Đang thử kết nối lại...');
    }

    startReconnectLoop(sessionId);
}

function bindEvents() {
    $('#btn-lock-question')?.addEventListener('click', confirmLockQuestion);
    $('#btn-end-session-top')?.addEventListener('click', confirmEndSession);
    $('#btn-toggle-drawer')?.addEventListener('click', () => $('#scanner-drawer')?.classList.toggle('hidden'));
    $('#btn-next-q-result')?.addEventListener('click', () => {
        SyncEngine.send({ type: 'NEXT_QUESTION' });
        setTimeout(() => SyncEngine.send({ type: 'REQUEST_STATE' }), 400);
        playSound('next');
    });
    $('#btn-show-choosers')?.addEventListener('click', showChoosersModal);
    $('#modal-overlay')?.addEventListener('click', e => {
        if (e.target === $('#modal-overlay')) hideModal();
    });
}

document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    const params = new URLSearchParams(location.search);
    const sessionId = params.get('session');
    if (!sessionId) {
        showView('no-session');
        return;
    }
    init(sessionId);
});
