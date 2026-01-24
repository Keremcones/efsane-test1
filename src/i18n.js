// Uluslararasılaştırma (i18n) Sistemi

const i18n = {
    currentLanguage: localStorage.getItem('language') || 'tr',
    
    translations: {
        tr: {
            profile: '👤 Profil',
            logout: '🚪 Çıkış Yap',
            dashboard: '🚀 Dashboard',
            settings: 'Ayarlar',
            email: 'Email',
            password: 'Şifre',
            save: '💾 Kaydet',
            cancel: 'İptal',
            profile_settings: '👤 Profil Ayarları',
            membership: 'Üyelik Planınız',
            account_info: '👤 Hesap Bilgileri',
            security: '🔒 Güvenlik',
            change_password: '🔐 Şifre Değiştir',
            appearance: '🎨 Görünüş',
            telegram: '✉️ Telegram Bildirimler',
            telegram_chat_id: 'Telegram Chat ID',
            change_pwd: '🔐 Şifre Değiştir',
            current_password: 'Mevcut Şifreniz',
            new_password: 'Yeni Şifre',
            confirm_password: 'Şifre Tekrar',
            close: 'Kapat',
            upgrade_premium: '⭐ Premium Planına Yükselt',
            login_tab: 'Giriş Yap',
            signup_tab: 'Kayıt Ol',
            login_button: 'Giriş Yap',
            signup_button: 'Kayıt Ol',
            pattern_recognition: '🎯 Formasyon Tanıma',
            multi_timeframe: '📊 Multi-Timeframe Analiz',
            fibonacci_levels: '📐 Fibonacci Seviyeleri',
            volume_profile: '📈 Volume Profile',
            ai_prediction: '🤖 AI Tahmin',
            news: '📰 Haberleri',
            market_sentiment: '📊 Piyasa Sentimenti',
            backtest: '📈 Backtest Sonuçları',
            basic_indicators: '📊 Temel İndikatörler',
            trading_signal: '🎯 Trading Sinyali',
            alarm_system: '🔔 Alarm Sistemi',
            confidence: 'Güven',
            no_news: 'Güncel haber yok',
            select_coin: 'Lütfen bir coin seçin',
            loading: 'Yükleniyor...',
            coin_not_found: 'Coin bulunamadı',
            search_coin: '🔍 Coin ara...',
            select_language: 'Dil Seçin',
            menu: 'Menü',
            close_menu: '×',
            change_pwd_title: '🔐 Şifre Değiştir',
            current_pwd: 'Mevcut Şifreniz',
            new_pwd: 'Yeni Şifre',
            confirm_pwd: 'Yeni Şifre (Tekrar)',
            save_changes: '💾 Değişiklikleri Kaydet',
            weak_password: '⚠️ Güçlü bir şifre kullanın: En az 8 karakter, büyük harf, küçük harf ve rakam içermelidir.',
            password_changed: '✅ Şifre başarıyla değiştirildi!',
            error: '❌ Bir hata oluştu',
            success: '✅ Başarılı',
            please_select_coin: 'Lütfen önce bir coin seçin',
            analysis_running: 'Analiz devam ediyor...',
            signal_not_found: 'Sinyal bulunamadı',
            alarm_type_select: 'Alarm tipi seçin:\n1. Fiyat Alarmı\n2. RSI Alarmı',
            price_alarm: 'Fiyat Alarmı',
            rsi_alarm: 'RSI Alarmı',
            condition_select: 'Koşul seçin:\n1. Fiyat Üstünde (above)\n2. Fiyat Altında (below)',
            rsi_condition: 'Koşul seçin:\n1. RSI > 70 (Aşırı Alım)\n2. RSI < 30 (Aşırı Satım)',
            price_above: 'Fiyat Üstünde',
            price_below: 'Fiyat Altında',
            rsi_overbought: 'RSI > 70 (Aşırı Alım)',
            rsi_oversold: 'RSI < 30 (Aşırı Satım)',
            alarm_value: 'Alarm Değeri',
            create_alarm: 'Alarm Oluştur',
            delete_alarm: 'Sil',
            no_alarms: 'Henüz alarm yok',
            theme_select: 'Tema Seçimi',
            light_theme: '☀️ Açık',
            dark_theme: '🌙 Koyu',
            theme_auto: 'Tüm sayfalarda otomatik olarak uygulanacaktır',
            last_password_change: 'Son şifre değiştirme:',
            info_loading: 'Bilgi yükleniyor...',
            email_readonly: 'Email adresini değiştiremezsiniz. Güvenlik nedeniyle bu ayar kilitlidir.',
            password_security: 'Hesabınızın güvenliğini sağlamak için şifrenizi düzenli olarak değiştiriniz.',
            telegram_setup: 'Telegram üzerinden alarm bildirimlerini almak için Telegram Chat ID\'nizi girin.',
            bot: 'Bot:',
            telegram_bot: '@Cryptosentinelsignalsbot',
            telegram_placeholder: 'Chat ID\'ni gir (sadece rakam)',
            clear: '🗑️ Sil',
            chat_id_guide: 'Chat ID Bulma Rehberi',
            theme_preference: 'Siteye uyacak temayı seçin. Tercihiniz otomatik olarak kaydedilir.',
            last_update: 'Son güncelleme:',
            signal_waiting: 'SİNYAL BEKLENIYOR',
            market_condition_wait: 'Piyasa koşulları uygun olana kadar bekleyin.',
            confidence_required: 'Güven skoru >= 40 gerekli.',
            confidence_score: 'Güven Skoru:',
            no_signal_found: 'Sinyal bulunamadı',
            live: 'Canlı',
            manage_account: 'Hesap bilgilerini ve tercihlerini yönet',
            standard_plan_desc: 'Standart özelliklerle kripto analizi yapın',
            email_cannot_change: 'ℹ️ Not: Email adresini değiştiremezsiniz. Güvenlik nedeniyle bu ayar kilitlidir.',
            password_security_notice: 'Hesabınızın güvenliğini sağlamak için şifrenizi düzenli olarak değiştiriniz.',
            password_strength: 'Güçlü bir şifre kullanın: En az 8 karakter, büyük harf, küçük harf ve rakam içermelidir.',
            telegram_notice: 'Telegram üzerinden alarm bildirimlerini almak için Telegram kullanıcı adınızı girin.',
            notifications_toggle: 'Telegram Bildirimlerini Aç',
            go_back: '← Geri Dön',
            save_button: '💾 Kaydet',
            find_chat_id_30sec: 'Chat ID\'nizi 30 Saniyede Bulun',
            open_telegram: 'Telegram uygulamasını açın',
            search_userinfobot: '@userinfobot adını arayın',
            send_start_command: '/start komutunu yazıp gönderin',
            copy_user_id: 'Bot tarafından gönderilen User ID\'yi kopyalayın',
            copy_digits_only: '💡 İpucu: Sadece rakamları kopyalayın, başka karakterleri eklemeyin',
        },
        en: {
            profile: '👤 Profile',
            logout: '🚪 Logout',
            dashboard: '🚀 Dashboard',
            settings: 'Settings',
            email: 'Email',
            password: 'Password',
            save: '💾 Save',
            cancel: 'Cancel',
            profile_settings: '👤 Profile Settings',
            membership: 'Your Membership Plan',
            account_info: '👤 Account Information',
            security: '🔒 Security',
            change_password: '🔐 Change Password',
            appearance: '🎨 Appearance',
            telegram: '✉️ Telegram Notifications',
            telegram_chat_id: 'Telegram Chat ID',
            change_pwd: '🔐 Change Password',
            current_password: 'Current Password',
            new_password: 'New Password',
            confirm_password: 'Confirm Password',
            close: 'Close',
            upgrade_premium: '⭐ Upgrade to Premium',
            login_tab: 'Login',
            signup_tab: 'Sign Up',
            login_button: 'Login',
            signup_button: 'Sign Up',
            pattern_recognition: '🎯 Pattern Recognition',
            multi_timeframe: '📊 Multi-Timeframe Analysis',
            fibonacci_levels: '📐 Fibonacci Levels',
            volume_profile: '📈 Volume Profile',
            ai_prediction: '🤖 AI Prediction',
            news: '📰 News',
            market_sentiment: '📊 Market Sentiment',
            backtest: '📈 Backtest Results',
            basic_indicators: '📊 Basic Indicators',
            trading_signal: '🎯 Trading Signal',
            alarm_system: '🔔 Alarm System',
            confidence: 'Confidence',
            no_news: 'No current news',
            select_coin: 'Please select a coin',
            loading: 'Loading...',
            coin_not_found: 'Coin not found',
            search_coin: '🔍 Search coin...',
            select_language: 'Select Language',
            menu: 'Menu',
            close_menu: '×',
            change_pwd_title: '🔐 Change Password',
            current_pwd: 'Current Password',
            new_pwd: 'New Password',
            confirm_pwd: 'Confirm Password (Again)',
            save_changes: '💾 Save Changes',
            weak_password: '⚠️ Use a strong password: At least 8 characters, uppercase, lowercase and number.',
            password_changed: '✅ Password changed successfully!',
            error: '❌ An error occurred',
            success: '✅ Success',
            please_select_coin: 'Please select a coin first',
            analysis_running: 'Analysis running...',
            signal_not_found: 'Signal not found',
            alarm_type_select: 'Select alarm type:\n1. Price Alarm\n2. RSI Alarm',
            price_alarm: 'Price Alarm',
            rsi_alarm: 'RSI Alarm',
            condition_select: 'Select condition:\n1. Price Above\n2. Price Below',
            rsi_condition: 'Select condition:\n1. RSI > 70 (Overbought)\n2. RSI < 30 (Oversold)',
            price_above: 'Price Above',
            price_below: 'Price Below',
            rsi_overbought: 'RSI > 70 (Overbought)',
            rsi_oversold: 'RSI < 30 (Oversold)',
            alarm_value: 'Alarm Value',
            create_alarm: 'Create Alarm',
            delete_alarm: 'Delete',
            no_alarms: 'No alarms yet',
            theme_select: 'Theme Selection',
            light_theme: '☀️ Light',
            dark_theme: '🌙 Dark',
            theme_auto: 'Will be automatically applied on all pages',
            last_password_change: 'Last password change:',
            info_loading: 'Loading information...',
            email_readonly: 'You cannot change email address. This setting is locked for security reasons.',
            password_security: 'Change your password regularly to keep your account secure.',
            telegram_setup: 'Enter your Telegram Chat ID to receive alarm notifications via Telegram.',
            bot: 'Bot:',
            telegram_bot: '@Cryptosentinelsignalsbot',
            telegram_placeholder: 'Enter Chat ID (digits only)',
            clear: '🗑️ Clear',
            chat_id_guide: 'Chat ID Finding Guide',
            theme_preference: 'Select a theme that suits the site. Your preference will be saved automatically.',
            last_update: 'Last update:',
            signal_waiting: 'WAITING FOR SIGNAL',
            market_condition_wait: 'Wait until market conditions are right.',
            confidence_required: 'Confidence score >= 40 required.',
            confidence_score: 'Confidence Score:',
            no_signal_found: 'Signal not found',
            live: 'Live',
            manage_account: 'Manage account information and preferences',
            standard_plan_desc: 'Analyze crypto with standard features',
            email_cannot_change: 'ℹ️ Note: You cannot change your email address. This setting is locked for security reasons.',
            password_security_notice: 'Change your password regularly to keep your account secure.',
            password_strength: 'Use a strong password: At least 8 characters, uppercase, lowercase and number.',
            telegram_notice: 'Enter your Telegram username to receive alarm notifications via Telegram.',
            notifications_toggle: 'Enable Telegram Notifications',
            go_back: '← Go Back',
            save_button: '💾 Save',
            find_chat_id_30sec: 'Find Your Chat ID in 30 Seconds',
            open_telegram: 'Open Telegram app',
            search_userinfobot: 'Search for @userinfobot',
            send_start_command: 'Type /start and send',
            copy_user_id: 'Copy the User ID sent by the bot',
            copy_digits_only: '💡 Tip: Copy only digits, do not add any other characters',
        },
    },

    t: function(key) {
        return this.translations[this.currentLanguage][key] || this.translations['tr'][key] || key;
    },

    setLanguage: function(lang) {
        if (this.translations[lang]) {
            this.currentLanguage = lang;
            localStorage.setItem('language', lang);
            this.applyLanguage();
        }
    },

    applyLanguage: function() {
        document.documentElement.lang = this.currentLanguage;
        
        const languageMap = {
            'tr': { flag: '🇹🇷', code: 'TR' },
            'en': { flag: '🇬🇧', code: 'EN' }
        };

        const langInfo = languageMap[this.currentLanguage] || languageMap['tr'];
        const flagEl = document.getElementById('currentLanguageFlag');
        const codeEl = document.getElementById('currentLanguageCode');
        
        if (flagEl) flagEl.textContent = langInfo.flag;
        if (codeEl) codeEl.textContent = langInfo.code;

        const langOptions = document.querySelectorAll('.language-option');
        langOptions.forEach(el => {
            el.classList.remove('active');
            if (el.getAttribute('data-lang') === this.currentLanguage) {
                el.classList.add('active');
            }
        });

        // Tüm data-i18n elementleri çevir
        const elements = document.querySelectorAll('[data-i18n]');
        elements.forEach(el => {
            const key = el.getAttribute('data-i18n');
            el.textContent = this.t(key);
        });

        // Placeholder'ları çevir
        this.translatePlaceholders();
        
        // Title attribute'lerini çevir
        this.translateTitles();

        window.dispatchEvent(new CustomEvent('languageChanged', { detail: { language: this.currentLanguage } }));
    },

    translatePlaceholders: function() {
        // Coin arama placeholder'ı
        const coinSearch = document.getElementById('coinSearch');
        if (coinSearch) {
            coinSearch.placeholder = this.t('search_coin');
        }

        // Telegram username placeholder'ı
        const telegramUsername = document.getElementById('telegramUsername');
        if (telegramUsername) {
            telegramUsername.placeholder = this.t('telegram_placeholder');
        }

        // Login form placeholders
        const loginEmail = document.getElementById('login-email');
        if (loginEmail) {
            loginEmail.placeholder = 'ornek@email.com';
        }
        const loginPassword = document.getElementById('login-password');
        if (loginPassword) {
            loginPassword.placeholder = '••••••••';
        }

        // Signup form placeholders
        const signupEmail = document.getElementById('signup-email');
        if (signupEmail) {
            signupEmail.placeholder = 'ornek@email.com';
        }
        const signupPassword = document.getElementById('signup-password');
        if (signupPassword) {
            signupPassword.placeholder = this.currentLanguage === 'tr' ? 'En az 6 karakter' : 'At least 6 characters';
        }
        const signupConfirm = document.getElementById('signup-password-confirm');
        if (signupConfirm) {
            signupConfirm.placeholder = this.currentLanguage === 'tr' ? 'Şifreyi tekrar girin' : 'Confirm password';
        }
    },

    translateTitles: function() {
        // Title attribute'lerini çevir
        const titleMap = {
            'Dil Seçin': 'select_language',
            'Menü': 'menu',
        };

        document.querySelectorAll('[title]').forEach(el => {
            const title = el.getAttribute('title');
            if (titleMap[title]) {
                el.setAttribute('title', this.t(titleMap[title]));
            }
        });
    },

    init: function() {
        this.applyLanguage();
        
        // Navbar dil düğmesini aktif göster
        const langBtnTr = document.getElementById('langBtnTr');
        const langBtnEn = document.getElementById('langBtnEn');
        if (langBtnTr && langBtnEn) {
            langBtnTr.classList.remove('active');
            langBtnEn.classList.remove('active');
            if (this.currentLanguage === 'tr') {
                langBtnTr.classList.add('active');
            } else if (this.currentLanguage === 'en') {
                langBtnEn.classList.add('active');
            }
        }
    }
};

// Global Functions
window.toggleLanguageDropdown = function() {
    const dropdown = document.getElementById('languageDropdown');
    if (dropdown) {
        dropdown.classList.toggle('active');
    }
};

window.changeLanguage = function(lang) {
    i18n.setLanguage(lang);
    // autoTranslate ile senkronize et
    if (typeof autoTranslate !== 'undefined') {
        autoTranslate.setLanguage(lang);
        autoTranslate.translateDOM();
    }
    const dropdown = document.getElementById('languageDropdown');
    if (dropdown) {
        dropdown.classList.remove('active');
    }
    
    // Dil düğmelerini güncelle (navbar'da)
    const langBtnTr = document.getElementById('langBtnTr');
    const langBtnEn = document.getElementById('langBtnEn');
    if (langBtnTr && langBtnEn) {
        langBtnTr.classList.remove('active');
        langBtnEn.classList.remove('active');
        if (lang === 'tr') {
            langBtnTr.classList.add('active');
        } else if (lang === 'en') {
            langBtnEn.classList.add('active');
        }
    }
    // Language change event dispatch (for backward compatibility)
    window.dispatchEvent(new CustomEvent('languageChanged', { detail: { language: lang } }));
};

// Init on page load
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        i18n.init();
        // autoTranslate ile senkronize et
        if (typeof autoTranslate !== 'undefined') {
            autoTranslate.init();
        }
    });
} else {
    i18n.init();
    if (typeof autoTranslate !== 'undefined') {
        autoTranslate.init();
    }
}

// Close dropdown when clicking outside
document.addEventListener('click', function(e) {
    const dropdown = document.getElementById('languageDropdown');
    const selector = document.querySelector('.language-selector');
    
    if (dropdown && selector && !selector.contains(e.target)) {
        dropdown.classList.remove('active');
    }
});
