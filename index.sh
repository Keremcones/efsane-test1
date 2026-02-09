      if (shouldTrigger && triggerMessage) {
        const symbol = String(alarm.symbol || "").toUpperCase();
        const marketType = String(alarm.market_type || "spot").toLowerCase() === "futures" ? "Futures" : "Spot";
        const timeframe = String(alarm.timeframe || "1h");
        const tpPercent = Number(alarm.tp_percent || 5);
        const slPercent = Number(alarm.sl_percent || 3);
        const directionTR = detectedSignal?.direction === "LONG" ? "LONG" : detectedSignal?.direction === "SHORT" ? "SHORT" : "UNKNOWN";
        const telegramMessage = `
🔔 ALARM AKTİVE! 🔔

💰 Çift: ${symbol}
🎯 ${directionTR} Sinyali Tespit Edildi!

📊 Piyasa:
   • Tip: ${marketType}
   • Zaman: ${timeframe}
   • Fiyat: $${indicators.price.toFixed(2)}

🎯 Sinyal:
   • Güven: ${detectedSignal?.score || 0}%
   • TP (Kar Al): ${tpPercent}%
   • SL (Stop Loss): ${slPercent}%
⏰ Zaman: ${new Date().toLocaleString("tr-TR")}
`;

        telegramPromises.push(sendTelegramNotification(alarm.user_id, telegramMessage));
        console.log(`✅ User alarm triggered for ${symbol}: ${triggerMessage}`);
      }
