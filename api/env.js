export default function handler(req, res) {
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=300");

  const env = {
    SUPABASE_URL: process.env.SUPABASE_URL || "",
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || "",
    TELEGRAM_FUNCTION_URL: process.env.TELEGRAM_FUNCTION_URL || ""
  };

  res.status(200).send(
    `window.__ENV_SUPABASE_URL=${JSON.stringify(env.SUPABASE_URL)};` +
      `window.__ENV_SUPABASE_ANON_KEY=${JSON.stringify(env.SUPABASE_ANON_KEY)};` +
      `window.__ENV_TELEGRAM_FUNCTION_URL=${JSON.stringify(env.TELEGRAM_FUNCTION_URL)};`
  );
}
