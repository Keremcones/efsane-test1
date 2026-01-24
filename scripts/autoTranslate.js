/**
 * AutoTranslate Module - Otomatik Çeviri Sistemi
 * Dinamik metinleri otomatik olarak Türkçe-İngilizce arasında çeviri yapar
 */

const autoTranslate = {
    // Çeviri veritabanı
    dictionary: {
        // Dinamik metinler - Placeholder'lar
        'Yükleniyor...': 'Loading...',
        'Bilgi yükleniyor...': 'Loading information...',
        'Lütfen bir coin seçin': 'Please select a coin',
        'Coin bulunamadı': 'Coin not found',
        'Coin ara...': 'Search coin...',
        'Menü': 'Menu',
        '×': '×',
        '💰 Volume (Yüksek)': '💰 Volume (High)',
        '📈 % Değişim (Yüksek)': '📈 % Change (High)',
        '📉 % Değişim (Düşük)': '📉 % Change (Low)',
        '🔤 İsim (A-Z)': '🔤 Name (A-Z)',
        
        // Formasyon ve İndikatörler
        'Formasyon Tanıma': 'Pattern Recognition',
        'Multi-Timeframe Analiz': 'Multi-Timeframe Analysis',
        'Fibonacci Seviyeleri': 'Fibonacci Levels',
        'Volume Profile': 'Volume Profile',
        'AI Tahmin': 'AI Prediction',
        'Piyasa Sentimenti': 'Market Sentiment',
        'Backtest Sonuçları': 'Backtest Results',
        'Temel İndikatörler': 'Basic Indicators',
        'Trading Sinyali': 'Trading Signal',
        'Alarm Sistemi': 'Alarm System',
        
        // Profil Sayfası
        'Profil Ayarları': 'Profile Settings',
        'Üyelik Planınız': 'Your Membership Plan',
        'Hesap Bilgileri': 'Account Information',
        'Güvenlik': 'Security',
        'Şifre Değiştir': 'Change Password',
        'Görünüş Tercihleri': 'Appearance Preferences',
        'Telegram Bildirimler': 'Telegram Notifications',
        
        // Form Elemanları
        'Email': 'Email',
        'Şifre': 'Password',
        'Mevcut Şifreniz': 'Current Password',
        'Yeni Şifre': 'New Password',
        'Şifre Tekrar': 'Confirm Password',
        'Kaydet': 'Save',
        'İptal': 'Cancel',
        'Kapat': 'Close',
        
        // Mesajlar
        'Başarılı': 'Success',
        'Hata': 'Error',
        'Uyarı': 'Warning',
        'Bilgi': 'Information',
        
        // Login/Signup
        'Giriş Yap': 'Login',
        'Kayıt Ol': 'Sign Up',
        'Şifremi Unuttum': 'Forgot Password',
        
        // Alarm Metinleri
        'Fiyat Alarmı': 'Price Alarm',
        'RSI Alarmı': 'RSI Alarm',
        'Fiyat Üstünde': 'Price Above',
        'Fiyat Altında': 'Price Below',
        'Alarm Oluştur': 'Create Alarm',
        'Sil': 'Delete',
        'Henüz alarm yok': 'No alarms yet',
        
        // Telegram
        'Telegram Chat ID': 'Telegram Chat ID',
        'Chat ID\'ni gir': 'Enter Chat ID',
        
        // Dashboard
        'Dashboard': 'Dashboard',
        'Profil': 'Profile',
        'Çıkış Yap': 'Logout',
        
        // Analiz Metinleri
        'Güven': 'Confidence',
        'Güncel haber yok': 'No current news',
        'Analiz devam ediyor': 'Analysis running...',
        'Sinyal bulunamadı': 'Signal not found',
        
        // Destek & Direnç
        'Destek & Direnç Seviyeleri': 'Support & Resistance Levels',
        'Destek Seviyeleri': 'Support Levels',
        'Direnç Seviyeleri': 'Resistance Levels',
        'Düşük (1-40): Çok fazla sinyal, yüksek zarar riski': 'Low (1-40): Too many signals, high loss risk',
        'Orta (40-70): Dengeli sinyal akışı': 'Medium (40-70): Balanced signal flow',
        'Yüksek (70-100): Az ama güvenilir sinyaller': 'High (70-100): Few but reliable signals',
        'Güven Skoru:': 'Confidence Score:',
        'Bot:': 'Bot:',
    },

    // Mevcut dil (i18n.js ile senkronize)
    currentLanguage: 'tr',

    /**
     * Metni çevir
     * @param {string} text - Çevirilecek metin
     * @returns {string} Çevirilen metin
     */
    translate: function(text) {
        if (!text) return text;
        
        // Eğer Türkçeyse direkt döndür
        if (this.currentLanguage === 'tr') {
            return text;
        }
        
        // İngilizceye çevir
        if (this.currentLanguage === 'en') {
            return this.dictionary[text.trim()] || text;
        }
        
        return text;
    },

    /**
     * Dil değişimini senkronize et (i18n.js ile)
     * @param {string} lang - Dil kodu ('tr' veya 'en')
     */
    setLanguage: function(lang) {
        this.currentLanguage = lang;
    },
    /**
     * DOM'da tüm metinleri çevir (data-auto-translate attribute'ü olanları)
     */
    translateDOM: function() {
        // Tüm dinamik metinleri çevir
        const elements = document.querySelectorAll('[data-auto-translate]');
        elements.forEach(el => {
            if (el.childNodes.length > 0) {
                el.childNodes.forEach(node => {
                    if (node.nodeType === 3) { // Text node
                        node.textContent = this.translate(node.textContent);
                    }
                });
            }
        });

        // Placeholder'ları çevir
        const inputs = document.querySelectorAll('[data-auto-translate-placeholder]');
        inputs.forEach(el => {
            const placeholder = el.getAttribute('data-auto-translate-placeholder');
            if (placeholder) {
                el.placeholder = this.translate(placeholder);
            }
        });

        // Title attribute'lerini çevir
        const titles = document.querySelectorAll('[data-auto-translate-title]');
        titles.forEach(el => {
            const title = el.getAttribute('data-auto-translate-title');
            if (title) {
                el.title = this.translate(title);
            }
        });
        
        // Dinamik olarak oluşturulan tüm metinleri çevir
        this.translateAllDynamicContent();
    },

    /**
     * Dinamik olarak oluşturulan tüm metinleri çevir
     */
    translateAllDynamicContent: function() {
        // Eğer İngilizce dilindeyse, tüm text node'ları scan et ve Türkçe yazıları çevir
        if (this.currentLanguage !== 'tr') {
            const walker = document.createTreeWalker(
                document.body,
                NodeFilter.SHOW_TEXT,
                null,
                false
            );
            
            let node;
            const nodesToUpdate = [];
            
            while (node = walker.nextNode()) {
                // Boş olmayan text node'ları topla
                if (node.textContent.trim().length > 0) {
                    const translated = this.translate(node.textContent);
                    if (translated !== node.textContent) {
                        nodesToUpdate.push({ node, translated });
                    }
                }
            }
            
            // Topladığımız text node'ları güncelle
            nodesToUpdate.forEach(item => {
                item.node.textContent = item.translated;
            });
        }
    },

    /**
     * Sözlüğe yeni çeviriler ekle
     * @param {object} translations - {türkçe: ingilizce} formatında çeviriler
     */
    addTranslations: function(translations) {
        Object.assign(this.dictionary, translations);
    },

    /**
     * i18n.js ile senkronizasyon
     */
    syncWithI18n: function() {
        // i18n.js'den dil bilgisini al
        if (typeof i18n !== 'undefined') {
            this.currentLanguage = i18n.currentLanguage;
            
            // i18n.js dil değiştiğinde autoTranslate'i de güncelle
            window.addEventListener('languageChanged', (e) => {
                this.setLanguage(e.detail.language);
                this.translateDOM();
            });
        }
    },

    /**
     * Sistem başlat
     */
    init: function() {
        // i18n.js ile senkronize et
        this.syncWithI18n();
        
        // İlk çeviriyi yap
        this.translateDOM();
    }
};

// Sayfa yüklendiğinde sistem başlat
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => autoTranslate.init());
} else {
    autoTranslate.init();
}
