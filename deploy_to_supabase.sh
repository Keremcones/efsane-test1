#!/bin/bash
# SUPABASE DEPLOYMENT SCRIPT
# Çalıştır: bash deploy_to_supabase.sh

KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpjcmJoZWtycGh4b2R4aGt1emp1Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTA5NjcxNCwiZXhwIjoyMDg0NjcyNzE0fQ.2JihLvUTz5ZJflVawlXaLVQ7ZBhvXitVtFoooG3fq_c"
URL="https://jcrbhekrphxodxhkuzju.supabase.co"

echo "🚀 SUPABASE DEPLOYMENT"
echo "===================="
echo ""
echo "STEP 1: alarms table recreate (clean schema)"
echo "STEP 2: RLS policies enable"
echo "STEP 3: user_settings add missing columns"
echo ""
echo "Visit: https://app.supabase.com/project/jcrbhekrphxodxhkuzju/sql/new"
echo ""
echo "=== EXECUTE THESE IN ORDER ==="
echo ""

echo "📋 MIGRATION 1: Alarms Clean Schema"
echo "---"
cat supabase/migrations/20260128191651_recreate_alarms_table.sql
echo ""
echo ""

echo "📋 MIGRATION 2: RLS Policies"
echo "---"
cat supabase/migrations/20260128192000_add_rls_policies.sql
echo ""
echo ""

echo "📋 MIGRATION 3: user_settings Add Columns"
echo "---"
cat supabase/migrations/20260128192200_create_user_settings_table.sql
echo ""

echo "✅ After executing above SQLs in SQL Editor:"
echo "  1. Check alarms table has clean columns"
echo "  2. Check RLS policies are active"
echo "  3. Check user_settings has new columns"
