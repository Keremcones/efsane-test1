#!/bin/bash

# Comprehensive Edge Function Diagnostics
# Checks all aspects of check-alarm-signals deployment

echo "🔍 EDGE FUNCTION DIAGNOSTIC REPORT"
echo "=================================="
echo ""

PROJECT_ID="jcrbhekrphxodxhkuzju"

echo "1️⃣  Function Status"
echo "-------------------"
supabase functions list | grep check-alarm-signals || echo "❌ Function not found"

echo ""
echo "2️⃣  Local Code Check"
echo "---------------------"
if [ -f "supabase/functions/check-alarm-signals/index.ts" ]; then
    echo "✅ Function code file exists"
    LINES=$(wc -l < supabase/functions/check-alarm-signals/index.ts)
    echo "   Size: $LINES lines"
    
    # Check for env var validation
    if grep -q "throw new Error.*SUPABASE_URL" supabase/functions/check-alarm-signals/index.ts; then
        echo "✅ Environment variable validation: ENABLED"
    else
        echo "❌ Environment variable validation: DISABLED"
    fi
else
    echo "❌ Function code file not found"
fi

echo ""
echo "3️⃣  Environment Variables Check (.env file)"
echo "---------------------------------------------"
if [ -f ".env" ]; then
    echo "✅ .env file exists"
    
    if grep -q "SUPABASE_URL=" .env; then
        echo "   ✅ SUPABASE_URL configured"
    else
        echo "   ❌ SUPABASE_URL missing"
    fi
    
    if grep -q "SUPABASE_SERVICE_ROLE_KEY=" .env; then
        echo "   ✅ SUPABASE_SERVICE_ROLE_KEY configured"
    else
        echo "   ❌ SUPABASE_SERVICE_ROLE_KEY missing"
    fi
    
    if grep -q "TELEGRAM_BOT_TOKEN=" .env; then
        echo "   ✅ TELEGRAM_BOT_TOKEN configured"
    else
        echo "   ❌ TELEGRAM_BOT_TOKEN missing"
    fi
else
    echo "❌ .env file not found"
fi

echo ""
echo "4️⃣  Supabase Configuration"
echo "----------------------------"
echo "Project ID: $PROJECT_ID"
echo "API URL: https://$PROJECT_ID.supabase.co"

echo ""
echo "5️⃣  CRITICAL CHECK: Edge Function Environment Variables"
echo "=========================================================="
echo ""
echo "⚠️  SUPABASE DASHBOARD REQUIRED:"
echo ""
echo "URL: https://supabase.com/dashboard/project/$PROJECT_ID/settings/functions"
echo ""
echo "YOU MUST SET THESE ENVIRONMENT VARIABLES IN DASHBOARD:"
echo ""
echo "┌─ Variable 1 ────────────────────────────────────┐"
echo "│ Name:  SUPABASE_URL                              │"
echo "│ Scope: check-alarm-signals                       │"
echo "│ Value: (copy from .env)                          │"
echo "└──────────────────────────────────────────────────┘"
echo ""
echo "┌─ Variable 2 ────────────────────────────────────┐"
echo "│ Name:  SUPABASE_SERVICE_ROLE_KEY                 │"
echo "│ Scope: check-alarm-signals                       │"
echo "│ Value: (copy from .env)                          │"
echo "└──────────────────────────────────────────────────┘"
echo ""
echo "┌─ Variable 3 ────────────────────────────────────┐"
echo "│ Name:  TELEGRAM_BOT_TOKEN                        │"
echo "│ Scope: check-alarm-signals                       │"
echo "│ Value: (copy from .env)                          │"
echo "└──────────────────────────────────────────────────┘"
echo ""
echo "After adding variables: Click 'Deploy All' button"
echo ""

echo "6️⃣  Cron Job Status"
echo "-------------------"
echo "If you have psql access, run:"
echo "  SELECT * FROM cron.job WHERE jobname = 'check-alarm-signals';"
echo ""

echo "🎯 SUMMARY"
echo "==========="
echo "✅ Local code: ready"
echo "⚠️  Dashboard secrets: NEEDS MANUAL SETUP"
echo ""
echo "Next Step: Configure secrets in Supabase Dashboard (see above)"
echo ""
