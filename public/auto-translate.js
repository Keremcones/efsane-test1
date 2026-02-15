window.autoTranslate = {
    currentLanguage: localStorage.getItem('language') || 'tr',
    sourceLanguage: 'tr',
    textNodeBaseMap: new WeakMap(),
    attrBaseMap: new WeakMap(),
    observer: null,
    isRunning: false,
    rerunRequested: false,
    scheduleTimer: null,
    loadingShown: false,

    dictionary: {
        'Canlı sinyaller aktif — 7/24 piyasa takibi': {
            en: 'Live signals are active — 24/7 market tracking',
            de: 'Live-Signale aktiv — 24/7 Marktüberwachung'
        },
        'Dil Seçimi': { en: 'Language Selection', de: 'Sprachauswahl' },
        'Özellikler': { en: 'Features', de: 'Funktionen' },
        'Fiyatlar': { en: 'Pricing', de: 'Preise' },
        'SSS': { en: 'FAQ', de: 'FAQ' },
        'Giriş Yap': { en: 'Login', de: 'Anmelden' },
        'Kayıt Ol': { en: 'Sign Up', de: 'Registrieren' },
        'Çıkış Yap': { en: 'Logout', de: 'Abmelden' },
        'Yükleniyor...': { en: 'Loading...', de: 'Wird geladen...' },
        'Bilgi yükleniyor...': { en: 'Loading information...', de: 'Informationen werden geladen...' },
        'Menü': { en: 'Menu', de: 'Menü' }
    },

    shouldTranslateText(text) {
        if (!text) return false;
        const normalized = text.replace(/\s+/g, ' ').trim();
        if (!normalized) return false;
        if (normalized.length < 2) return false;
        if (/^[\d\s.,:%+\-–—()\[\]{}\/\\|]+$/.test(normalized)) return false;
        return true;
    },

    preserveWhitespace(original, translatedCore) {
        const leading = original.match(/^\s*/)?.[0] || '';
        const trailing = original.match(/\s*$/)?.[0] || '';
        return `${leading}${translatedCore}${trailing}`;
    },

    getCacheStore() {
        const key = `auto_translate_cache_${this.currentLanguage}`;
        try {
            const parsed = JSON.parse(localStorage.getItem(key) || '{}');
            if (parsed && typeof parsed === 'object') return parsed;
            return {};
        } catch {
            return {};
        }
    },

    saveCacheStore(store) {
        const key = `auto_translate_cache_${this.currentLanguage}`;
        try {
            localStorage.setItem(key, JSON.stringify(store));
        } catch {
            // ignore quota errors
        }
    },

    lookupDictionary(text) {
        const direct = this.dictionary[text];
        if (!direct) return null;
        return direct[this.currentLanguage] || null;
    },

    async translateBatchViaApi(texts) {
        if (!texts.length || this.currentLanguage === 'tr') return [];

        const targetLanguage = this.currentLanguage;
        const separator = '\n[[[SEP]]]\n';
        const joined = texts.join(separator);

        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${this.sourceLanguage}&tl=${targetLanguage}&dt=t&q=${encodeURIComponent(joined)}`;

        const response = await fetch(url, { method: 'GET' });
        if (!response.ok) {
            throw new Error(`Translation API failed: ${response.status}`);
        }

        const data = await response.json();
        const translatedJoined = Array.isArray(data?.[0])
            ? data[0].map(part => part?.[0] || '').join('')
            : '';

        const translatedParts = translatedJoined.split(separator);
        if (translatedParts.length === texts.length) {
            return translatedParts;
        }

        return texts.map((_, i) => translatedParts[i] || texts[i]);
    },

    async resolveTranslations(uniqueTexts) {
        const cacheStore = this.getCacheStore();
        const resolved = {};
        const apiCandidates = [];

        uniqueTexts.forEach(text => {
            const dictValue = this.lookupDictionary(text);
            if (dictValue) {
                resolved[text] = dictValue;
                return;
            }

            if (cacheStore[text]) {
                resolved[text] = cacheStore[text];
                return;
            }

            apiCandidates.push(text);
        });

        const batchSize = 25;
        for (let i = 0; i < apiCandidates.length; i += batchSize) {
            const batch = apiCandidates.slice(i, i + batchSize);
            try {
                const translated = await this.translateBatchViaApi(batch);
                batch.forEach((source, index) => {
                    const output = translated[index] || source;
                    resolved[source] = output;
                    cacheStore[source] = output;
                });
            } catch {
                batch.forEach(source => {
                    resolved[source] = source;
                });
            }
        }

        this.saveCacheStore(cacheStore);
        return resolved;
    },

    collectTextNodes() {
        const nodes = [];
        if (!document.body) return nodes;

        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
            const parent = node.parentElement;
            if (!parent) continue;
            if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE'].includes(parent.tagName)) continue;
            if (parent.classList.contains('language-option')) continue;

            const baseText = this.textNodeBaseMap.get(node) ?? node.textContent;
            this.textNodeBaseMap.set(node, baseText);

            if (!this.shouldTranslateText(baseText)) continue;
            nodes.push({ node, baseText });
        }

        return nodes;
    },

    collectAttributeTargets() {
        const targets = [];
        const attrs = ['placeholder', 'title', 'aria-label'];

        attrs.forEach(attr => {
            document.querySelectorAll(`[${attr}]`).forEach(el => {
                let elementBase = this.attrBaseMap.get(el);
                if (!elementBase) {
                    elementBase = {};
                    this.attrBaseMap.set(el, elementBase);
                }

                const base = elementBase[attr] ?? el.getAttribute(attr) ?? '';
                if (!base) return;
                elementBase[attr] = base;

                if (!this.shouldTranslateText(base)) return;
                targets.push({ el, attr, baseText: base });
            });
        });

        return targets;
    },

    applyOriginalLanguage(nodeTargets, attrTargets) {
        nodeTargets.forEach(item => {
            item.node.textContent = item.baseText;
        });

        attrTargets.forEach(item => {
            item.el.setAttribute(item.attr, item.baseText);
        });
    },

    async runTranslation() {
        if (this.isRunning) {
            this.rerunRequested = true;
            return;
        }

        this.isRunning = true;
        if (this.currentLanguage !== 'tr') {
            this.setLoadingState(true);
        }

        try {
            const nodeTargets = this.collectTextNodes();
            const attrTargets = this.collectAttributeTargets();

            if (this.currentLanguage === 'tr') {
                this.applyOriginalLanguage(nodeTargets, attrTargets);
                return;
            }

            const allTexts = [
                ...nodeTargets.map(t => t.baseText),
                ...attrTargets.map(t => t.baseText)
            ];
            const uniqueTexts = Array.from(new Set(allTexts));

            const translatedMap = await this.resolveTranslations(uniqueTexts);

            nodeTargets.forEach(item => {
                const translated = translatedMap[item.baseText] || item.baseText;
                item.node.textContent = this.preserveWhitespace(item.baseText, translated);
            });

            attrTargets.forEach(item => {
                const translated = translatedMap[item.baseText] || item.baseText;
                item.el.setAttribute(item.attr, this.preserveWhitespace(item.baseText, translated));
            });
        } finally {
            this.isRunning = false;

            if (this.rerunRequested) {
                this.rerunRequested = false;
                this.scheduleTranslate(100);
            } else {
                this.setLoadingState(false);
            }
        }
    },

    setLoadingState(isLoading) {
        if (this.loadingShown === isLoading) return;
        this.loadingShown = isLoading;
        window.dispatchEvent(new CustomEvent('translationLoading', {
            detail: {
                isLoading,
                language: this.currentLanguage
            }
        }));
    },

    scheduleTranslate(delay = 150) {
        clearTimeout(this.scheduleTimer);
        this.scheduleTimer = setTimeout(() => {
            this.runTranslation();
        }, delay);
    },

    translate(text) {
        if (!text || this.currentLanguage === 'tr') return text;

        const dict = this.lookupDictionary(text.trim());
        if (dict) return this.preserveWhitespace(text, dict);
        return text;
    },

    translateDOM() {
        this.scheduleTranslate(0);
    },

    setLanguage(lang) {
        this.currentLanguage = lang;
        if (lang === 'tr') {
            this.setLoadingState(false);
        }
        this.scheduleTranslate(0);
    },

    setupMutationObserver() {
        if (this.observer || !document.body) return;

        this.observer = new MutationObserver(() => {
            this.scheduleTranslate(180);
        });

        this.observer.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['placeholder', 'title', 'aria-label']
        });
    },

    syncWithI18n() {
        if (typeof i18n !== 'undefined') {
            this.currentLanguage = i18n.currentLanguage;
        }

        window.addEventListener('languageChanged', (event) => {
            const lang = event?.detail?.language;
            if (!lang) return;
            this.currentLanguage = lang;
            this.scheduleTranslate(0);
        });
    },

    init() {
        this.syncWithI18n();
        this.setupMutationObserver();
        this.scheduleTranslate(0);
    }
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => autoTranslate.init());
} else {
    autoTranslate.init();
}
