export default function handler(req, res) {
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=300");

  const supabaseUrl = process.env.SUPABASE_URL || "";
  const rawAnonKey = process.env.SUPABASE_ANON_KEY || "";
  const publishableAnonKey = rawAnonKey.startsWith("sb_publishable_") ? rawAnonKey : "";

  const env = {
    SUPABASE_URL: supabaseUrl,
    SUPABASE_ANON_KEY: publishableAnonKey,
    GTM_CONTAINER_ID: process.env.GTM_CONTAINER_ID || "",
    GA_MEASUREMENT_ID: process.env.GA_MEASUREMENT_ID || "",
    CORS_PROXY: process.env.CORS_PROXY || ""
  };

  res.status(200).send(
    `window.__ENV_SUPABASE_URL=${JSON.stringify(env.SUPABASE_URL)};` +
      `window.__ENV_SUPABASE_ANON_KEY=${JSON.stringify(env.SUPABASE_ANON_KEY)};` +
      `window.__ENV_GTM_CONTAINER_ID=${JSON.stringify(env.GTM_CONTAINER_ID)};` +
      `window.__ENV_GA_MEASUREMENT_ID=${JSON.stringify(env.GA_MEASUREMENT_ID)};` +
        `window.__ENV_CORS_PROXY=${JSON.stringify(env.CORS_PROXY)};`
  );
}
