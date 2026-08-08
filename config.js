/**
 * Cấu hình chung — Presenter (máy tính) ↔ Scanner (điện thoại / Vercel)
 *
 * App quét deploy tại:
 *   https://scanner-kappa-one.vercel.app
 */
const PaperModeConfig = {
    APP_NAME: 'Thẻ Xoay',
    APP_TAGLINE: 'Xoay thẻ · Giơ lên · Trả lời vui!',

    SCANNER_APP_URL: 'https://scanner-kappa-one.vercel.app',

    STORAGE_KEY: 'paperModeScannerUrl',

    OLD_URLS: [
        'https://che-do-giay-scanner.vercel.app',
        'https://scanner-che-do-giay.vercel.app'
    ],

    getScannerBaseUrl() {
        const custom = (localStorage.getItem(this.STORAGE_KEY) || '').trim().replace(/\/$/, '');
        if (this.OLD_URLS.includes(custom)) {
            localStorage.removeItem(this.STORAGE_KEY);
            return this.SCANNER_APP_URL;
        }
        return custom || this.SCANNER_APP_URL;
    },

    saveScannerBaseUrl(url) {
        const u = (url || '').trim().replace(/\/$/, '');
        if (u) localStorage.setItem(this.STORAGE_KEY, u);
        else localStorage.removeItem(this.STORAGE_KEY);
    },

    getScannerJoinUrl(sessionId) {
        if (!sessionId) return '';
        const base = this.getScannerBaseUrl().replace(/\/$/, '');
        return `${base}/?session=${encodeURIComponent(sessionId)}`;
    }
};

if (typeof module !== 'undefined') module.exports = PaperModeConfig;
