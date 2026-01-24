/**
 * Telegram Notification Message Templates
 * Alarm Sistemi için 3 temel bildirim şablonu
 */

const TelegramNotificationTemplates = {
  /**
   * Yeni alarm oluşturuldu bildirimi
   * @param {Object} data - { symbol, targetPrice, condition, timestamp }
   */
  alarmCreated: (data) => {
    const conditionText = data.condition === 'above' ? '⬆️ Fiyat Üzerine Çıktığında' : '⬇️ Fiyat Altına İndiğinde';
    return `✅ *Alarm Oluşturuldu!*

📊 Kripto: *${data.symbol}*
🎯 Hedef Fiyat: *$${data.targetPrice}*
📌 Koşul: ${conditionText}
⏰ Oluşturma Zamanı: ${data.timestamp}

🔔 Fiyat hedefe ulaştığında bildirim alacaksınız`;
  },

  /**
   * Alarm tetiklendi bildirimi
   * @param {Object} data - { symbol, targetPrice, condition, currentPrice, timestamp }
   */
  alarmTriggered: (data) => {
    const conditionText = data.condition === 'above' ? '⬆️ Üzeri' : '⬇️ Altı';
    return `🚨 *Alarm Tetiklendi!*

📊 Kripto: *${data.symbol}*
🎯 Hedef Fiyat: *$${data.targetPrice}*
💹 Güncel Fiyat: *$${data.currentPrice}*
📌 Koşul: ${conditionText}
⏰ Tetiklenme Zamanı: ${data.timestamp}

✔️ Alarm Aktif - Gerekli işlemleri yapabilirsiniz`;
  },

  /**
   * Alarm sonlandırıldı bildirimi
   * @param {Object} data - { symbol, targetPrice, reason, timestamp }
   */
  alarmEnded: (data) => {
    const reasonText = data.reason === 'deleted' ? 'Silindi' : 'Süresi Doldu';
    return `⏹️ *Alarm Sonlandırıldı*

📊 Kripto: *${data.symbol}*
🎯 Hedef Fiyat: *$${data.targetPrice}*
📝 Neden: *${reasonText}*
⏰ Sonlandırma Zamanı: ${data.timestamp}

🔔 Bu alarm artık aktif değildir`;
  }
};

// Export for Node.js/Browser
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TelegramNotificationTemplates;
}
