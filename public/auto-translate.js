window.autoTranslate = {
    currentLanguage: localStorage.getItem('language') || 'tr',
    sourceLanguage: 'auto',
    textNodeBaseMap: new WeakMap(),
    attrBaseMap: new WeakMap(),
    observer: null,
    isRunning: false,
    rerunRequested: false,
    scheduleTimer: null,
    loadingShown: false,
    pendingRoots: new Set(),
    fullScanRequested: false,
    loadingForManualSwitch: false,

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
        'Menü': { en: 'Menu', de: 'Menü' },
        'Her Durumda': { en: 'All Conditions', de: 'In jeder Lage' },
        'Binance Bağlantısı': { en: 'Binance Connection', de: 'Binance-Verbindung' },
        'Binance API anahtarlarınızı ve otomatik trade ayarlarınızı yönetin': { en: 'Manage your Binance API keys and auto-trade settings', de: 'Verwalte deine Binance-API-Schlüssel und Auto-Trade-Einstellungen' },
        'Otomatik Trade\'i Aktif Et': { en: 'Enable Auto Trade', de: 'Auto-Trade aktivieren' },
        'Futures Ayarları': { en: 'Futures Settings', de: 'Futures-Einstellungen' },
        'Futures Otomatik Trade': { en: 'Futures Auto Trade', de: 'Futures Auto-Trade' },
        'Kaldıraç': { en: 'Leverage', de: 'Hebel' },
        'Emir Tipi': { en: 'Order Type', de: 'Ordertyp' },
        'Limit Sapma (%) (Emir fiyatindan ne kadar uzak olsun)': { en: 'Limit Deviation (%) (How far from order price)', de: 'Limit-Abweichung (%) (Abstand zum Auftragspreis)' },
        'Spot Ayarları': { en: 'Spot Settings', de: 'Spot-Einstellungen' },
        'Spot Otomatik Trade': { en: 'Spot Auto Trade', de: 'Spot Auto-Trade' },
        'API Bağlantısını Test Et': { en: 'Test API Connection', de: 'API-Verbindung testen' },
        'Kaydet': { en: 'Save', de: 'Speichern' },
        'Bağlantı durumu': { en: 'Connection status', de: 'Verbindungsstatus' },
        'Otomatik trade kapalıyken test başlatılamaz. Önce Otomatik Trade\'i açın.': { en: 'Test cannot start while auto trade is disabled. Enable Auto Trade first.', de: 'Test kann nicht starten, solange Auto-Trade deaktiviert ist. Aktiviere zuerst Auto-Trade.' },
        'Otomatik trade işlemleri tamamen sizin sorumluluğunuzdadır. Kayıp riski vardır.': { en: 'Auto trade operations are entirely your responsibility. There is risk of loss.', de: 'Auto-Trade-Operationen liegen vollständig in deiner Verantwortung. Es besteht Verlustrisiko.' },
        'Bar kapanışı hesaplaması Binance otomatik trade\'de desteklenmiyor.': { en: 'Bar close calculation is not supported in Binance auto trade.', de: 'Die Bar-Close-Berechnung wird im Binance Auto-Trade nicht unterstützt.' },
        'Minimum miktar/precision nedeniyle küçük bakiyelerde işlem açılmayabilir.': { en: 'Due to minimum amount/precision, trades may not open on small balances.', de: 'Aufgrund von Mindestmenge/Präzision werden bei kleinen Guthaben möglicherweise keine Trades eröffnet.' },
        'Bu sayfadaki alanlara yapıştırıp Kaydet butonuna basın, ardından API Bağlantısını Test Et butonuyla doğrulayın.': { en: 'Paste into the fields on this page, press Save, then verify with Test API Connection.', de: 'Füge die Daten in die Felder dieser Seite ein, klicke auf Speichern und prüfe anschließend mit API-Verbindung testen.' },
        'Binance bağlantısı sadece Premium üyeler için aktif.': { en: 'Binance connection is only active for Premium members.', de: 'Die Binance-Verbindung ist nur für Premium-Mitglieder aktiv.' },
        'Yatırım danışmanlığı değildir; genel bilgilendirme amaçlıdır, sorumluluk kullanıcıya aittir.': { en: 'This is not investment advice; for general information only, responsibility belongs to the user.', de: 'Dies ist keine Anlageberatung; nur allgemeine Informationen, die Verantwortung liegt beim Nutzer.' },
        'Binance ayarları kaydedildi.': { en: 'Binance settings saved.', de: 'Binance-Einstellungen gespeichert.' },
        'Binance bağlantısı başarılı.': { en: 'Binance connection successful.', de: 'Binance-Verbindung erfolgreich.' },
        'Bağlantı başarısız.': { en: 'Connection failed.', de: 'Verbindung fehlgeschlagen.' },
        'Gelişmiş Teknik Analiz Dashboard': { en: 'Advanced Technical Analysis Dashboard', de: 'Erweitertes Technisches Analyse-Dashboard' },
        'Piyasa Tipi:': { en: 'Market Type:', de: 'Markttyp:' },
        'Volume (Yüksek)': { en: 'Volume (High)', de: 'Volumen (Hoch)' },
        '% Değişim (Yüksek)': { en: '% Change (High)', de: '% Änderung (Hoch)' },
        '% Değişim (Düşük)': { en: '% Change (Low)', de: '% Änderung (Niedrig)' },
        'İsim (A-Z)': { en: 'Name (A-Z)', de: 'Name (A-Z)' },
        'Güncelleniyor...': { en: 'Updating...', de: 'Wird aktualisiert...' },
        'Analiz sistemi henüz yüklenmedi. Lütfen sayfayı yenile.': { en: 'Analysis system has not loaded yet. Please refresh the page.', de: 'Das Analysesystem ist noch nicht geladen. Bitte aktualisiere die Seite.' },
        'Gelişmiş analiz yapılıyor...': { en: 'Advanced analysis in progress...', de: 'Erweiterte Analyse läuft...' },
        'Güçlü': { en: 'Strong', de: 'Stark' },
        'Orta': { en: 'Medium', de: 'Mittel' },
        'Zayıf': { en: 'Weak', de: 'Schwach' },
        'Yükseliş': { en: 'Bullish', de: 'Bullisch' },
        'Düşüş': { en: 'Bearish', de: 'Bärisch' },
        'Nötr': { en: 'Neutral', de: 'Neutral' },
        'Tespit Edildi!': { en: 'Detected!', de: 'Erkannt!' },
        'Formasyon Tanıma': { en: 'Pattern Recognition', de: 'Mustererkennung' },
        'Formasyon bulunamadı': { en: 'No pattern detected', de: 'Kein Muster erkannt' },
        'Şu anda grafikte belirgin formasyon yok': { en: 'There is no clear pattern on the chart right now', de: 'Derzeit ist kein klares Muster im Chart erkennbar' },
        'Multi-Timeframe Analiz': { en: 'Multi-Timeframe Analysis', de: 'Multi-Timeframe-Analyse' },
        'Veri bekleniyor': { en: 'Waiting for data', de: 'Warte auf Daten' },
        'Fibonacci Seviyeleri': { en: 'Fibonacci Levels', de: 'Fibonacci-Niveaus' },
        'AI Tahmin': { en: 'AI Prediction', de: 'KI-Prognose' },
        'ile tahmin': { en: 'prediction with', de: 'Prognose mit' },
        'Tahmin Fiyat': { en: 'Predicted Price', de: 'Prognostizierter Preis' },
        'Haberleri': { en: 'News', de: 'Nachrichten' },
        'Güncel haber yok': { en: 'No current news', de: 'Keine aktuellen Nachrichten' },
        'Bu coin ile ilgili haberleri yakında göreceksiniz': { en: 'You will see news about this coin soon', de: 'Du wirst bald Nachrichten zu diesem Coin sehen' },
        'Pozitif': { en: 'Positive', de: 'Positiv' },
        'Negatif': { en: 'Negative', de: 'Negativ' },
        'Piyasa Sentimenti': { en: 'Market Sentiment', de: 'Marktstimmung' },
        'Korku': { en: 'Fear', de: 'Angst' },
        'Açgözlülük': { en: 'Greed', de: 'Gier' },
        'Backtest Sonuçları': { en: 'Backtest Results', de: 'Backtest-Ergebnisse' },
        'Backtest bölümünde işlem açıkken alarm kurarsanız, alarm kurulduktan sonra oluşan yeni sinyal şartlarına göre bildirim gelir. Bu nedenle backtestteki açık işlem ile canlı alarm birebir aynı zamanlamayı göstermez.': { en: 'If you set an alarm while a trade is open in Backtest, notifications are sent according to new signal conditions formed after the alarm is set. Therefore, an open trade in backtest and a live alarm may not show exactly the same timing.', de: 'Wenn du einen Alarm setzt, während im Backtest eine Position offen ist, kommen Benachrichtigungen nach neuen Signalbedingungen, die nach dem Alarm entstehen. Daher zeigen offene Backtest-Position und Live-Alarm nicht exakt dieselbe Zeit.' },
        'TP/SL fiyatlarında coin’e göre farklı küsuratlar görülebilir. Bunun nedeni her sembolün fiyat adımı (tick size) ve ondalık hassasiyetinin farklı olmasıdır; yüzde hedefler fiyata çevrilirken borsa kurallarına göre yuvarlama/kırpma uygulanır.': { en: 'TP/SL prices may show different decimals per coin. This is because each symbol has different tick size and decimal precision; when percentage targets are converted to prices, exchange rounding/truncation rules are applied.', de: 'Bei TP/SL-Preisen können je Coin unterschiedliche Dezimalstellen auftreten. Der Grund sind verschiedene Tick-Size- und Präzisionsregeln je Symbol; bei der Umrechnung von Prozentzielen in Preise werden Börsen-Rundungsregeln angewendet.' },
        'Toplam Kar': { en: 'Total Profit', de: 'Gesamtgewinn' },
        'Backtest güncelleniyor...': { en: 'Backtest updating...', de: 'Backtest wird aktualisiert...' },
        'Giriş Fiyatı': { en: 'Entry Price', de: 'Einstiegspreis' },
        'Açık P&L': { en: 'Open P&L', de: 'Offenes P&L' },
        'Çıkış Fiyatı': { en: 'Exit Price', de: 'Ausstiegspreis' },
        'TP (Hedef Fiyat)': { en: 'TP (Target Price)', de: 'TP (Zielpreis)' },
        'Kar/Zarar': { en: 'Profit/Loss', de: 'Gewinn/Verlust' },
        'Sinyal Açılış': { en: 'Signal Open', de: 'Signalstart' },
        'Süre': { en: 'Duration', de: 'Dauer' },
        'Sinyal Gücü': { en: 'Signal Strength', de: 'Signalstärke' },
        'AKTİF': { en: 'ACTIVE', de: 'AKTIV' },
        'Filtreye uygun işlem yok': { en: 'No trades match the filter', de: 'Keine Trades entsprechen dem Filter' },
        'Canlı': { en: 'Live', de: 'Live' },
        'Son güncelleme:': { en: 'Last update:', de: 'Letzte Aktualisierung:' },
        'Temel İndikatörler': { en: 'Core Indicators', de: 'Kernindikatoren' },
        'Destek & Direnç Seviyeleri': { en: 'Support & Resistance Levels', de: 'Unterstützungs- & Widerstandsniveaus' },
        'Destek Seviyeleri': { en: 'Support Levels', de: 'Unterstützungsniveaus' },
        'Direnç Seviyeleri': { en: 'Resistance Levels', de: 'Widerstandsniveaus' },
        'Trend Gücü Özeti': { en: 'Trend Strength Summary', de: 'Trendstärke-Zusammenfassung' },
        'Trend Eğilimi': { en: 'Trend Bias', de: 'Trendrichtung' },
        'Güç (ADX):': { en: 'Strength (ADX):', de: 'Stärke (ADX):' },
        'Günlük & Haftalık Aralık': { en: 'Daily & Weekly Range', de: 'Tages- & Wochenbereich' },
        'Trading Sinyali': { en: 'Trading Signal', de: 'Trading-Signal' },
        'Sinyal Güven Eşiği': { en: 'Signal Confidence Threshold', de: 'Signal-Vertrauensschwelle' },
        'Düşük (1-40):': { en: 'Low (1-40):', de: 'Niedrig (1-40):' },
        'Çok fazla sinyal, yüksek zarar riski': { en: 'Too many signals, high loss risk', de: 'Zu viele Signale, hohes Verlustrisiko' },
        'Orta (40-70):': { en: 'Medium (40-70):', de: 'Mittel (40-70):' },
        'Dengeli sinyal akışı': { en: 'Balanced signal flow', de: 'Ausgeglichener Signalfluss' },
        'Yüksek (70-100):': { en: 'High (70-100):', de: 'Hoch (70-100):' },
        'Az ama güvenilir sinyaller': { en: 'Fewer but more reliable signals', de: 'Weniger, aber zuverlässigere Signale' },
        'SİNYAL AKTİF': { en: 'SIGNAL ACTIVE', de: 'SIGNAL AKTIV' },
        'Sinyal Saati': { en: 'Signal Time', de: 'Signalzeit' },
        'Güven Skoru:': { en: 'Confidence Score:', de: 'Vertrauensscore:' },
        'Giriş': { en: 'Entry', de: 'Einstieg' },
        'Risk/Ödül:': { en: 'Risk/Reward:', de: 'Risiko/Ertrag:' },
        'SİNYAL BEKLENIYOR': { en: 'WAITING FOR SIGNAL', de: 'SIGNAL WIRD ERWARTET' },
        'Piyasa koşulları uygun olana kadar bekleyin.': { en: 'Wait until market conditions are suitable.', de: 'Warte, bis die Marktbedingungen geeignet sind.' },
        'Güven skoru >= 40 gerekli.': { en: 'Confidence score >= 40 required.', de: 'Vertrauensscore >= 40 erforderlich.' },
        'Fiyat Grafiği': { en: 'Price Chart', de: 'Preisdiagramm' },
        'Alarm kurmak için Premium gerekli': { en: 'Premium is required to create an alarm', de: 'Premium ist erforderlich, um einen Alarm zu erstellen' },
        'Lütfen önce bir coin seçin ve analiz yapılmasını bekleyin': { en: 'Please select a coin first and wait for analysis to complete', de: 'Bitte wähle zuerst einen Coin und warte, bis die Analyse abgeschlossen ist' },
        'Stop Loss 0.1 - 99 araliginda olmali': { en: 'Stop Loss must be between 0.1 and 99', de: 'Stop Loss muss zwischen 0.1 und 99 liegen' },
        'Alarm kuruldu! Otomatik trade aktif.': { en: 'Alarm created! Auto trade is active.', de: 'Alarm erstellt! Auto-Trade ist aktiv.' },
        'Alarm kuruldu! Telegram\'da bildirim alacaksınız': { en: 'Alarm created! You will receive notifications on Telegram', de: 'Alarm erstellt! Du erhältst Benachrichtigungen auf Telegram' },
        'Henüz işlem yok. Aktif alarm oluşturduktan sonra işlemler burada gösterilecek.': { en: 'No trades yet. Trades will appear here after you create an active alarm.', de: 'Noch keine Trades. Trades werden hier angezeigt, nachdem du einen aktiven Alarm erstellt hast.' },
        'Henüz aktif sinyal yok.': { en: 'No active signals yet.', de: 'Noch keine aktiven Signale.' },
        'KARDA': { en: 'IN PROFIT', de: 'IM GEWINN' },
        'ZARARDA': { en: 'IN LOSS', de: 'IM VERLUST' }
    },

    shouldTranslateText(text) {
        if (!text) return false;
        const normalized = text.replace(/\s+/g, ' ').trim();
        if (!normalized) return false;
        if (normalized.length < 2) return false;
        if (/^[\d\s.,:%+\-–—()\[\]{}\/\\|]+$/.test(normalized)) return false;
        const alphaCount = (normalized.match(/[A-Za-zÀ-ÖØ-öø-ÿÇĞİÖŞÜçğıöşü]/g) || []).length;
        if (/\d/.test(normalized) && alphaCount < 2) return false;
        if (normalized.length > 120 && /\d/.test(normalized) && alphaCount < 10) return false;
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

    lookupDictionaryFlexible(text) {
        const normalized = String(text || '').trim();
        if (!normalized) return null;

        const direct = this.lookupDictionary(normalized);
        if (direct) return direct;

        for (const [sourceTr, variants] of Object.entries(this.dictionary)) {
            if (!variants || typeof variants !== 'object') continue;
            const sourceEn = String(variants.en || '').trim();
            const sourceDe = String(variants.de || '').trim();

            if (normalized === sourceTr.trim() || normalized === sourceEn || normalized === sourceDe) {
                const target = variants[this.currentLanguage];
                if (target) return target;
            }
        }

        return null;
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
            const dictValue = this.lookupDictionaryFlexible(text);
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

    needsNetworkTranslation(uniqueTexts) {
        if (!uniqueTexts.length || this.currentLanguage === 'tr') return false;
        const cacheStore = this.getCacheStore();
        return uniqueTexts.some(text => {
            if (!text) return false;
            if (this.lookupDictionaryFlexible(text)) return false;
            if (cacheStore[text]) return false;
            return true;
        });
    },

    normalizeRoots(roots) {
        const normalized = [];
        const seen = new Set();

        (roots || []).forEach(root => {
            if (!root) return;

            let element = null;
            if (root.nodeType === Node.DOCUMENT_NODE) {
                element = root.body || null;
            } else if (root.nodeType === Node.ELEMENT_NODE) {
                element = root;
            } else if (root.nodeType === Node.TEXT_NODE) {
                element = root.parentElement;
            }

            if (!element || !document.body?.contains(element)) return;
            if (seen.has(element)) return;

            seen.add(element);
            normalized.push(element);
        });

        return normalized;
    },

    collectTextNodes(roots) {
        const nodes = [];
        if (!document.body) return nodes;

        const rootElements = this.normalizeRoots(roots);
        const targets = rootElements.length ? rootElements : [document.body];

        targets.forEach(target => {
            const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
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
        });

        return nodes;
    },

    collectAttributeTargets(roots) {
        const targets = [];
        const attrs = ['placeholder', 'title', 'aria-label'];
        const rootElements = this.normalizeRoots(roots);

        const collectForElement = (el, attr) => {
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
        };

        attrs.forEach(attr => {
            if (!rootElements.length) {
                document.querySelectorAll(`[${attr}]`).forEach(el => collectForElement(el, attr));
                return;
            }

            rootElements.forEach(root => {
                if (root.hasAttribute?.(attr)) {
                    collectForElement(root, attr);
                }
                root.querySelectorAll?.(`[${attr}]`).forEach(el => collectForElement(el, attr));
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

        const roots = this.fullScanRequested ? [] : Array.from(this.pendingRoots);
        this.pendingRoots.clear();
        this.fullScanRequested = false;

        this.isRunning = true;

        try {
            const nodeTargets = this.collectTextNodes(roots);
            const attrTargets = this.collectAttributeTargets(roots);

            if (this.currentLanguage === 'tr') {
                this.applyOriginalLanguage(nodeTargets, attrTargets);
                this.setLoadingState(false);
                return;
            }

            const allTexts = [
                ...nodeTargets.map(t => t.baseText),
                ...attrTargets.map(t => t.baseText)
            ];
            const uniqueTexts = Array.from(new Set(allTexts));

            if (this.loadingForManualSwitch && this.needsNetworkTranslation(uniqueTexts)) {
                this.setLoadingState(true);
            }

            const translatedMap = await this.resolveTranslations(uniqueTexts);

            nodeTargets.forEach(item => {
                const translated = translatedMap[item.baseText] || item.baseText;
                item.node.textContent = this.preserveWhitespace(item.baseText, translated);
            });

            attrTargets.forEach(item => {
                const translated = translatedMap[item.baseText] || item.baseText;
                item.el.setAttribute(item.attr, this.preserveWhitespace(item.baseText, translated));
            });

            this.setLoadingState(false);
            this.loadingForManualSwitch = false;
        } finally {
            this.isRunning = false;

            if (this.rerunRequested) {
                this.rerunRequested = false;
                this.scheduleTranslate(100);
            } else {
                this.setLoadingState(false);
                this.loadingForManualSwitch = false;
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

    scheduleTranslate(delay = 150, fullScan = false) {
        if (fullScan) {
            this.fullScanRequested = true;
            this.pendingRoots.clear();
        }
        clearTimeout(this.scheduleTimer);
        this.scheduleTimer = setTimeout(() => {
            this.runTranslation();
        }, delay);
    },

    translate(text) {
        if (!text || this.currentLanguage === 'tr') return text;

        const dict = this.lookupDictionaryFlexible(text.trim());
        if (dict) return this.preserveWhitespace(text, dict);
        return text;
    },

    translateDOM() {
        this.loadingForManualSwitch = true;
        this.scheduleTranslate(0, true);
    },

    setLanguage(lang) {
        this.currentLanguage = lang;
        this.loadingForManualSwitch = true;
        if (lang === 'tr') {
            this.setLoadingState(false);
        }
        this.scheduleTranslate(0, true);
    },

    queueRoot(node) {
        if (!node || !document.body) return;
        let element = null;

        if (node.nodeType === Node.DOCUMENT_NODE) {
            element = node.body || null;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            element = node;
        } else if (node.nodeType === Node.TEXT_NODE) {
            element = node.parentElement;
        }

        if (!element || !document.body.contains(element)) return;
        this.pendingRoots.add(element);
    },

    handleMutations(mutations) {
        mutations.forEach(mutation => {
            if (mutation.type === 'characterData') {
                this.queueRoot(mutation.target);
                return;
            }

            if (mutation.type === 'attributes') {
                this.queueRoot(mutation.target);
                return;
            }

            if (mutation.type === 'childList') {
                mutation.addedNodes?.forEach(node => this.queueRoot(node));
                if (mutation.target) {
                    this.queueRoot(mutation.target);
                }
            }
        });

        this.scheduleTranslate(140, false);
    },

    setupMutationObserver() {
        if (this.observer || !document.body) return;

        this.observer = new MutationObserver((mutations) => {
            this.handleMutations(mutations);
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
            this.loadingForManualSwitch = true;
            this.scheduleTranslate(0, true);
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
