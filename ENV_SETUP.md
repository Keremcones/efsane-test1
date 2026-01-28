# 🚀 Environment Variables Setup

## Vercel Deployment

### 1. Set Environment Variables in Vercel

Go to **Vercel Dashboard → Project Settings → Environment Variables** and add:

```
SUPABASE_URL=your-project-url.supabase.co
SUPABASE_ANON_KEY=your-anon-key-here
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key (BACKEND ONLY)
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_BOT_USERNAME=@your-bot-name
TELEGRAM_FUNCTION_URL=your-function-url
```

### 2. Frontend (.env.local) - Local Development Only

Create `.env.local` file in the project root:

```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
VITE_TELEGRAM_FUNCTION_URL=https://your-function-url
```

### 3. Add to .gitignore

```
.env
.env.local
.env.*.local
vercel.json (optional - if contains secrets)
```

## 🔐 Security Rules

### ✅ DO
- ✅ Put ANON_KEY in frontend (safe, read-only)
- ✅ Put SERVICE_ROLE_KEY only in backend/API
- ✅ Use Vercel Environment Variables for deployment
- ✅ Enable RLS on all database tables
- ✅ Use parameterized queries (not string interpolation)
- ✅ Rotate keys regularly

### ❌ DON'T
- ❌ Commit .env to git
- ❌ Expose SERVICE_ROLE_KEY in frontend
- ❌ Hardcode sensitive keys in source code
- ❌ Use credentials in URLs
- ❌ Store secrets in localStorage

## 📝 How to Get Keys

### Supabase
1. Go to https://supabase.com/dashboard
2. Select your project
3. Settings → API
4. Copy ANON and SERVICE_ROLE keys

### Telegram Bot
1. Message @BotFather on Telegram
2. Create new bot: `/newbot`
3. Get your token

## ✅ Testing Credentials

```javascript
// Test in console (F12)
console.log('URL:', window.__ENV_SUPABASE_URL);
console.log('Key loaded:', !!window.__ENV_SUPABASE_ANON_KEY);
```

If undefined, check Vercel Environment Variables.
