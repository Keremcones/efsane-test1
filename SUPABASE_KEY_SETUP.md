🚀 SUPABASE KEY KURULUMU - EN HIZLI YÖNTEM

## ⚡ 30 Saniyede Çöz

### 1️⃣ Supabase Dashboard Aç
```
https://app.supabase.com/project/jcrbhekrphxodxhkuzju/settings/api
```

### 2️⃣ "Project API keys" Bölümü
Sayfada bu yazıyor:
```
┌─────────────────┬──────────────────────────────────────┐
│ anon (public)   │ eyJhbGc... [COPY]                   │ ← BUNU KOPYALA
└─────────────────┴──────────────────────────────────────┘
```

### 3️⃣ Browser Console'u Aç
Dashboard'da: F12 → Console sekmesi

### 4️⃣ Magik Komut Yapıştır
```javascript
setSupabaseKey('eyJhbGc...')
```
(Kopyalanan key'i yapıştır)

### 5️⃣ Enter Tuşuna Bas
```
✅ Supabase ANON_KEY kaydedildi!
📝 Key: eyJhbGc...
🔄 Sayfayı refresh et
```

### 6️⃣ Sayfa Refresh Et
```
Cmd+R (Mac) veya Ctrl+R (Windows)
```

### ✅ BITTI!
- 401 hatası kapanmış olmalı
- Alarmlar yüklenecek
- WebSocket bağlantı açılacak

---

## 🔍 ALTERNATİF: .env Dosyasından

Eğer console'u kullanmak istemezsen:

1. Proje klasöründe `.env` dosyası aç
2. Satır 3'ü düzenle:
```
SUPABASE_ANON_KEY=eyJhbGc...
```

3. Live Server'ı restart et
4. Hard refresh yapARAK

---

## ⚠️ GÜVENLİK NOTU

✅ **ANON_KEY public, sorun yok**
- Frontend'te kullanılır
- Tüm tarayıcılara görünür
- Git'e commit edebilirs

❌ **SERVICE_ROLE_KEY SECRET, asla expose etme!**
- Backenende kullanılır
- Git'e commit ETME
- Vercel'de secret olarak sakla

---

## 🧪 TEST

Console'a yazıp Enter:
```javascript
console.log(SUPABASE_ANON_KEY)
```

Çıktı:
```
eyJhbGc... (boş değil ise ✅)
```

---

**Sorun olursa:**
1. Key'i tam kopyaladın mı?
2. Browser cache temizle (Ctrl+Shift+Del)
3. Hard refresh et
4. Live Server restart et

✨ İşlem bitince: Deploy edebilirsin!
