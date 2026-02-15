// Otomatik çeviri yardımcı katmanı (TR -> EN/DE)

window.autoTranslate = {
    currentLanguage: localStorage.getItem('language') || 'tr',
    originalTextNodes: new WeakMap(),

    dictionary: {
        'Canlı sinyaller aktif — 7/24 piyasa takibi': {
            en: 'Live signals are active — 24/7 market tracking',
            de: 'Live-Signale aktiv — 24/7 Marktüberwachung'
        },
        'Özellikler': { en: 'Features', de: 'Funktionen' },
        'Fiyatlar': { en: 'Pricing', de: 'Preise' },
        'SSS': { en: 'FAQ', de: 'FAQ' },
        'Giriş Yap': { en: 'Login', de: 'Anmelden' },
        'Kayıt Ol': { en: 'Sign Up', de: 'Registrieren' },
        'Çıkış Yap': { en: 'Logout', de: 'Abmelden' },
        'Telegram İletişim': { en: 'Telegram Contact', de: 'Telegram Kontakt' },
        'Mobil için Başla': { en: 'Start on Mobile', de: 'Für Mobil starten' },
        'Masaüstü için Başla': { en: 'Start on Desktop', de: 'Für Desktop starten' },
        'Aktif Kullanıcı': { en: 'Active Users', de: 'Aktive Nutzer' },
        'Üretilen Sinyal': { en: 'Generated Signals', de: 'Erzeugte Signale' },
        'Kesintisiz Çalışma': { en: 'Uptime', de: 'Betriebszeit' },
        'Desteklenen Parite': { en: 'Supported Pairs', de: 'Unterstützte Paare' },
        'Yükleniyor...': { en: 'Loading...', de: 'Wird geladen...' },
        'Bilgi yükleniyor...': { en: 'Loading information...', de: 'Informationen werden geladen...' },
        'Lütfen bir coin seçin': { en: 'Please select a coin', de: 'Bitte wählen Sie eine Coin' },
        'Coin bulunamadı': { en: 'Coin not found', de: 'Coin nicht gefunden' },
        'Coin ara...': { en: 'Search coin...', de: 'Coin suchen...' },
        'Menü': { en: 'Menu', de: 'Menü' },
        'Profil': { en: 'Profile', de: 'Profil' },
        'Dashboard': { en: 'Dashboard', de: 'Dashboard' },
        'Kaydet': { en: 'Save', de: 'Speichern' },
        'İptal': { en: 'Cancel', de: 'Abbrechen' },
        'Kapat': { en: 'Close', de: 'Schließen' },
        'Başarılı': { en: 'Success', de: 'Erfolg' },
        'Hata': { en: 'Error', de: 'Fehler' },
        'Uyarı': { en: 'Warning', de: 'Warnung' },
        'Bilgi': { en: 'Info', de: 'Info' }
    },

    preserveWhitespace(source, translatedCore) {
        const leading = source.match(/^\s*/)?.[0] || '';
        const trailing = source.match(/\s*$/)?.[0] || '';
        return `${leading}${translatedCore}${trailing}`;
    },

    translate(text) {
        if (!text || this.currentLanguage === 'tr') return text;

        const trimmed = text.trim();
        const item = this.dictionary[trimmed];
        if (!item) return text;

        const translated = item[this.currentLanguage];
        if (!translated) return text;

        return this.preserveWhitespace(text, translated);
    },

    setLanguage(lang) {
        this.currentLanguage = lang;
    },

    translateDOM() {
        const attrElements = document.querySelectorAll('[data-auto-translate]');
        attrElements.forEach(el => {
            if (el.childNodes.length > 0) {
                el.childNodes.forEach(node => {
                    if (node.nodeType === Node.TEXT_NODE) {
                        const base = this.originalTextNodes.get(node) ?? node.textContent;
                        this.originalTextNodes.set(node, base);
                        node.textContent = this.translate(base);
                    }
                });
            }
        });

        this.translateAllTextNodes();
    },

    translateAllTextNodes() {
        if (!document.body) return;

        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;

        while ((node = walker.nextNode())) {
            const parentTag = node.parentElement?.tagName;
            if (!parentTag || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(parentTag)) {
                continue;
            }

            if (!node.textContent || !node.textContent.trim()) {
                continue;
            }

            const base = this.originalTextNodes.get(node) ?? node.textContent;
            this.originalTextNodes.set(node, base);
            node.textContent = this.translate(base);
        }
    },

    syncWithI18n() {
        if (typeof i18n !== 'undefined') {
            this.currentLanguage = i18n.currentLanguage;
        }

        window.addEventListener('languageChanged', (e) => {
            if (!e?.detail?.language) return;
            this.setLanguage(e.detail.language);
            this.translateDOM();
        });
    },

    init() {
        this.syncWithI18n();
        this.translateDOM();
    }
};
