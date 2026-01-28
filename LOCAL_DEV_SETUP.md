# 🔧 LOCAL DEVELOPMENT SETUP

## ✅ Yapılması Gerekenler

### 1. Live Server Açık mı?
```
VS Code: Go Live (sağ altta "Go Live" tuşu)
```

### 2. Tarayıcıyı Refresh Et
```
Ctrl+Shift+R (hard refresh - cache temizle)
veya
Cmd+Shift+R (macOS)
```

### 3. Kontroller

#### config.js Kontrol
```javascript
// LOCAL_DEV objesi eklendi:
const LOCAL_DEV = {
    SUPABASE_URL: 'https://jcrbhekrphxodxhkuzju.supabase.co',
    SUPABASE_ANON_KEY: 'eyJhbGc...', 
    TELEGRAM_BOT_TOKEN: '8572447825:AAE...',
    TELEGRAM_BOT_USERNAME: 'HerSeyOkAlarmBot'
};
```

#### toast-manager.js Kontrol
```javascript
// DOMContentLoaded event listener eklendi
if (document.body) {
    this.initContainer();
} else {
    document.addEventListener('DOMContentLoaded', () => this.initContainer());
}
```

---

## 🚀 VERCEL DEPLOYMENT İÇİN

Vercel'e yüklediğinde, `config.js` değişikmeyecek ama ENV değişkenleri gerekecek:

### Vercel Environment Variables

1. Vercel Dashboard → Project Settings → Environment Variables
2. Ekle:

```
VITE_SUPABASE_URL=https://jcrbhekrphxodxhkuzju.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGc...
VITE_TELEGRAM_BOT_TOKEN=8572447825:AAE...
VITE_TELEGRAM_BOT_USERNAME=HerSeyOkAlarmBot
```

3. `config.js` değiştir:

```javascript
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || LOCAL_DEV.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || LOCAL_DEV.SUPABASE_ANON_KEY || '';
```

---

## 🧪 TEST ADIMLAR

1. **Sayfa açıldı mı?**
   - Hatalar yoksa login.html yönlendi
   - Console'da hata yoksa başarılı

2. **Toast çalışıyor mu?**
   - Tarayıcı console: `showTestToast()`
   - Sağ üst köşede bildirim görünmeli

3. **Supabase bağlandı mı?**
   - Login olunca session görünmeli
   - Console: `supabaseClient.auth.getSession()`

---

## ⚠️ Sorun Olursa

**Toast error hala görülürse:**
```
- Browser cache temizle (Ctrl+Shift+Delete)
- Hard refresh yap (Ctrl+Shift+R)
- Live server restart et
```

**Supabase credentials hata:**
```
- Console'da SUPABASE_URL ve SUPABASE_ANON_KEY yazdır
- Kontrol et: config.js LOCAL_DEV değerleri doğru mu
```

---

**Sonraki**: Supabase migrations'ı deploy et
