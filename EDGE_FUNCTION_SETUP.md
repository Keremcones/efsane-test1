# 🔴 CRITICAL: Edge Function Environment Variables Setup

## Problem
Edge Function `check-alarm-signals` is running but **NOT** receiving environment variables:
- SUPABASE_URL
- SUPABASE_SERVICE_ROLE_KEY  
- TELEGRAM_BOT_TOKEN

This is why the function crashes or silently fails.

## Solution: Add Secrets to Supabase Dashboard

### Step 1: Open Supabase Settings
Go to: https://supabase.com/dashboard/project/jcrbhekrphxodxhkuzju/settings/functions

### Step 2: Copy Values from .env File
```bash
# Run this in terminal to see your .env values:
cat .env
```

You'll see:
```
SUPABASE_URL=https://jcrbhekrphxodxhkuzju.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIs...
TELEGRAM_BOT_TOKEN=8572447825:AAEkE3NUcqI3Ocd...
```

### Step 3: Add Variables to Dashboard

#### Variable 1: SUPABASE_URL
```
Name:   SUPABASE_URL
Scope:  check-alarm-signals
Value:  https://jcrbhekrphxodxhkuzju.supabase.co
```
Click "Add"

#### Variable 2: SUPABASE_SERVICE_ROLE_KEY
```
Name:   SUPABASE_SERVICE_ROLE_KEY
Scope:  check-alarm-signals
Value:  [paste full key from .env]
```
Click "Add"

#### Variable 3: TELEGRAM_BOT_TOKEN
```
Name:   TELEGRAM_BOT_TOKEN
Scope:  check-alarm-signals
Value:  [paste full token from .env]
```
Click "Add"

### Step 4: Deploy
1. Go back to "Edge Functions" tab
2. Click "Deploy all" button
3. Wait for deployment to complete (should show ✅ or green status)

### Step 5: Verify
Run in SQL Editor:
```sql
SELECT * FROM cron.job_run_details 
ORDER BY start_time DESC 
LIMIT 1;
```

Should see:
- `status: succeeded`
- `start_time: within last minute`

Check Logs tab in Edge Functions:
- Should see "🚀 [CRON] Starting alarm signals check" messages
- No more "FATAL: ... not set" errors

## Troubleshooting

**Q: Where do I find SUPABASE_SERVICE_ROLE_KEY?**
A: In your local .env file. Run `grep SUPABASE_SERVICE_ROLE_KEY .env`

**Q: The long token - should I copy the whole thing?**
A: YES! Copy the entire value, including "eyJhbGc..." prefix.

**Q: Do I need to redeploy the function?**
A: After adding variables, click "Deploy all". The function code itself is already deployed.

**Q: How long does deployment take?**
A: Usually 30 seconds to 2 minutes.

**Q: How do I know it worked?**
A: 
1. Edge Function logs show NO errors about missing variables
2. Cron job starts hitting the function every minute
3. Edge Function logs show "📊 Found X active alarms"

## Current Status

✅ Function code: DEPLOYED and READY
✅ Cron job: RUNNING every 1 minute  
✅ .env file: ALL VARIABLES CONFIGURED LOCALLY
⏳ Edge Function secrets: **PENDING DASHBOARD SETUP** ← YOU ARE HERE

---

**Next Action:** Go to Supabase Dashboard and add the 3 environment variables above.

