# Dashboard ↔ Edge Parity Rehberi

Bu doküman, sistemin Dashboard (frontend/backtest) ve Edge (canlı sinyal/close akışı) tarafında birebir uyumlu kalması için hazırlanmıştır.
Amaç: AI veya geliştirici kod yazarken aynı kuralları uygulamak, farklı sonuç üretimini engellemek.

---

## 1) Parity Tanımı (Ne demek?)

Parity şu demektir:
- Aynı coin, aynı market, aynı timeframe, aynı TP/SL ve aynı confidence ile çalışıldığında,
- Dashboard tarafında görülen sinyal/backtest davranışı ile Edge tarafındaki canlı karar mantığı aynı prensiplerle çalışır.

Not: Canlıda gerçek piyasa akışı nedeniyle birebir aynı zaman/mum gerçekleşmesi garantisi yoktur; hedef algoritma ve parametre uyumudur.

---

## 2) Tek Kaynak Parametreler (Source of Truth)

Aşağıdaki alanlar her iki tarafta aynı kabul edilmelidir:
- market_type: spot / futures
- timeframe
- takeProfitPercent (TP)
- stopLossPercent (SL)
- confidenceThreshold
- directionFilter (varsayılan: BOTH)
- backtestDays
- backtestSlippageBps
- backtestFeeBps

Temel kural:
- Dashboard veya Kazananlar tarafında backtest çağrısı yapılırken slippage/fee mutlaka geçirilmelidir.
- Parametrelerden biri eksikse parity bozulur.

---

## 3) Kritik Dosyalar ve Sorumlulukları

- public/advanced-indicators.js
  - runBacktest(...) ana hesap motoru
  - tick yuvarlama, slippage, fee etkileri, trade istatistikleri

- public/index.html
  - Dashboard backtest çağrısı
  - URL parametreleri ile (symbol, market, tf, tp, sl, conf) çalışma

- public/kazananlar.html
  - Kazananlar listesi için backtest çağrıları
  - Dashboard ile aynı parametre setini göndermeli

- supabase/functions/check-alarm-signals/index.ts
  - Canlı sinyal açma/kapama, TP/SL close, telegram akışı
  - Auto-trade açık/kapalı ayrımı

---

## 4) Değişmez Kurallar (Invariants)

### 4.1 Backtest çağrısı
Her yerde aynı parametre sırası/mantığı kullanılmalı:
- symbol, timeframe, days, confidence, tp, sl, marketType, directionFilter, slippageBps, feeBps

### 4.2 Tick davranışı
- TP/SL fiyatları tick adımına göre hesaplanır/yuvarlanır.
- Tick kaynaklı sapma küçük TP/SL değerlerinde daha belirgin olur.
- Kazananlar tarafında tick uygunluk etiketi gösterimi, bu gerçekliğe göre yapılır.

### 4.3 Auto-trade davranışı
- Auto-trade kapalı kullanıcıda sinyal aktif kalır; dashboard PnL takibi devam eder.
- Auto-trade açık kullanıcıda order açılışı başarısızsa NOT_FILLED/girilemedi akışı çalışır.

### 4.4 Close sebep modeli
- TP_HIT, SL_HIT, TIMEOUT, NOT_FILLED, EXTERNAL_CLOSE gibi close_reason değerleri normalize edilerek yazılmalı.
- Rastgele yeni reason eklenmemeli; DB kısıtları ve mesaj şablonları birlikte düşünülmeli.

---

## 5) AI Kodlama Kuralları (Zorunlu)

AI bir değişiklik yapmadan önce:
1. İlgili akış Dashboard mu, Kazananlar mı, Edge mi belirle.
2. Aynı parametrelerin diğer tarafta nasıl geçtiğini kontrol et.
3. Bir tarafta hesap değişiyorsa, parity gereği diğer tarafta da eşdeğer güncelleme yap.
4. "Sadece bu sayfada" yaklaşımıyla metrik hesaplama çatallaması yapma.

AI bir değişiklik yaptıktan sonra:
1. Kazananlar ile Dashboard aynı parametrelerle aynı coin test edilmeli.
2. Edge function için close/open akışı bozulmadığı doğrulanmalı.
3. Deploy sonrası aktif sürüm doğrulanmalı.

---

## 6) Parity Bozan Yaygın Hatalar

- Backtest çağrısında slippage/fee göndermemek
- Farklı confidence değeri ile karşılaştırma yapmak
- Farklı timeframe/market ile ekranları kıyaslamak
- Dashboard URL parametrelerini taşımadan coin detaya gitmek
- Kazananlar’da fallback custom metric kullanıp Dashboard’da motor çıktısını kullanmak
- Edge’te close_reason modelini frontend’den bağımsız değiştirmek

---

## 7) PR / Commit Öncesi Kontrol Listesi

- Aynı coin ile Dashboard vs Kazananlar:
  - market aynı
  - timeframe aynı
  - TP/SL aynı
  - confidence aynı
  - backtestDays aynı
  - slippage/fee aynı

- Auto-trade kapalı kullanıcı:
  - sinyal ACTIVE kalıyor mu
  - PnL takibi sürüyor mu

- Auto-trade açık kullanıcı:
  - open başarısız senaryosunda NOT_FILLED akışı çalışıyor mu

- Edge deploy:
  - fonksiyon aktif sürüm güncellendi mi

---

## 8) Operasyon Notları

- Frontend değişiklikleri: GitHub push sonrası Vercel otomatik deploy.
- Edge değişiklikleri: Supabase function deploy ve active version kontrolü şart.

Örnek doğrulama komutu:
- supabase functions list

---

## 9) Kısa Özet

Tek cümle kural:
- Dashboard’da ne hesaplanıyorsa Kazananlar da aynı motor ve aynı parametrelerle hesaplanmalı; Edge tarafı da aynı iş kural setine bağlı kalmalıdır.

Bu dosya parity için referans dokümandır. Yeni geliştirici/AI değişikliklerinde ilk kontrol noktası olarak kullanılmalıdır.
