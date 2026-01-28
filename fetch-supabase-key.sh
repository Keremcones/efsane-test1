#!/bin/bash

# 🔑 Supabase ANON_KEY Auto-Fetcher
# Bu script Supabase Dashboard'dan key'i otomatik alır

echo "🔍 Supabase Dashboard'dan ANON_KEY almaya çalışılıyor..."
echo ""

# Yöntem 1: Supabase CLI login
echo "Yöntem 1: Supabase CLI Login"
if command -v supabase &> /dev/null; then
    # Supabase dashboard link
    echo "👉 Şu linki aç: https://app.supabase.com/account/tokens"
    echo ""
    echo "Adımlar:"
    echo "1. Create new token tuşuna bas"
    echo "2. Token'ı kopyala"
    echo "3. Aşağıdaki komutta terminal'e yapıştır:"
    echo ""
    echo "supabase projects list"
    echo ""
    echo "Sonra bu script'i tekrar çalıştır!"
else
    echo "❌ Supabase CLI kurulu değil"
fi

echo ""
echo "---"
echo ""

# Yöntem 2: Browser Console
echo "Yöntem 2: Browser Console'dan (Daha hızlı!)"
echo ""
echo "1. Dashboard aç: https://app.supabase.com/project/jcrbhekrphxodxhkuzju/settings/api"
echo "2. Browser Console aç (F12)"
echo "3. Aşağıdaki kodu yapıştır:"
echo ""
echo "const key = document.querySelector('[data-testid=\"anon-key-copy-button\"]')?.parentElement?.textContent || 'Key bulunamadı';"
echo "console.log(key);"
echo ""
echo "4. Enter tuşuna bas"
echo "5. Çıkan key'i kopyala"
echo "6. Terminal'e yapıştır:"
echo ""
echo "export SUPABASE_ANON_KEY='YOUR_KEY_HERE'"
echo ""

echo ""
echo "---"
echo ""
echo "Yöntem 3: curl ile (Token lazım)"
echo ""
echo "Eğer token var ise:"
echo "curl -s -H 'Authorization: Bearer YOUR_TOKEN' https://api.supabase.com/v1/projects/jcrbhekrphxodxhkuzju/api-keys | jq"
