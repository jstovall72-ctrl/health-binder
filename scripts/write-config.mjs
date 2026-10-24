// Runs on every Netlify build: writes public/config.js from the site's environment variables.
// The Supabase URL and anon/publishable key are meant to be public; your data is protected
// by the Row Level Security rules in supabase/schema.sql, not by hiding these values.
import { writeFileSync } from "node:fs";

const url = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const key = (process.env.SUPABASE_ANON_KEY || "").trim();
if (!url || !key) console.warn("⚠ SUPABASE_URL or SUPABASE_ANON_KEY is not set. The site will show a setup message.");
if (process.env.SUPABASE_SERVICE_ROLE_KEY) console.warn("⚠ Never put the service_role / secret key in Netlify. It is not used by this site.");

writeFileSync("public/config.js",
  `window.HB_CONFIG = ${JSON.stringify({ supabaseUrl: url, supabaseKey: key })};\n`);
console.log("Wrote public/config.js for", url || "(no project)");
