'use strict';

/**
 * IndexedDB storage for Thẻ Xoay — migrates legacy localStorage on first run.
 */
const IDBStore = {
    DB_NAME: 'TheXoayDB',
    DB_VERSION: 1,
    MIGRATED_FLAG: 'theXoay_idb_migrated_v1',

    db: null,
    cache: {
        classes: [],
        questionSets: [],
        history: [],
        settings: { soundEnabled: true, countNoAnswerAsWrong: false }
    },

    async init() {
        await this._open();
        await this._migrateFromLocalStorage();
        await this._loadAll();
    },

    _open() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(this.DB_NAME, this.DB_VERSION);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('kv')) {
                    db.createObjectStore('kv', { keyPath: 'key' });
                }
            };
            req.onsuccess = () => { this.db = req.result; resolve(); };
            req.onerror = () => reject(req.error);
        });
    },

    _get(key) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('kv', 'readonly');
            const req = tx.objectStore('kv').get(key);
            req.onsuccess = () => resolve(req.result?.value);
            req.onerror = () => reject(req.error);
        });
    },

    _set(key, value) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('kv', 'readwrite');
            tx.objectStore('kv').put({ key, value });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    },

    async _migrateFromLocalStorage() {
        if (localStorage.getItem(this.MIGRATED_FLAG)) return;

        const map = {
            classes: 'paperModeClasses',
            questionSets: 'paperModeQuestionSets',
            history: 'paperModeSessions',
            settings: 'paperModeSettings'
        };

        for (const [cacheKey, lsKey] of Object.entries(map)) {
            try {
                const raw = localStorage.getItem(lsKey);
                if (!raw) continue;
                const val = JSON.parse(raw);
                await this._set(cacheKey, val);
            } catch { /* skip corrupt entries */ }
        }

        localStorage.setItem(this.MIGRATED_FLAG, String(Date.now()));
    },

    async _loadAll() {
        for (const key of ['classes', 'questionSets', 'history', 'settings']) {
            const val = await this._get(key);
            if (val === undefined) continue;
            if (key === 'settings') this.cache.settings = { ...this.cache.settings, ...val };
            else this.cache[key] = val;
        }
    },

    persist(key) {
        const val = key === 'settings' ? this.cache.settings : this.cache[key];
        return this._set(key, val).catch(err => console.error('IDB persist failed:', key, err));
    }
};

if (typeof module !== 'undefined') module.exports = IDBStore;
