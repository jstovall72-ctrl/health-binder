// Health Binder: "Fill in from documents"
// A Supabase Edge Function that reads the signed-in user's own uploaded files
// and asks Claude to pull out the visit details as JSON.
//
// Secrets it needs (Supabase Dashboard → Edge Functions → Secrets):
//   ANTHROPIC_API_KEY   your key from console.anthropic.com   (required)
//   ANTHROPIC_MODEL     optional, defaults to claude-sonnet-5-5
// SUPABASE_URL and SUPABASE_ANON_KEY are provided by Supabase automatically.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const MAX_IMAGE = 5 * 1024 * 1024;        // Claude's per-image limit
const MAX_TOTAL = 24 * 1024 * 1024;       // stay well under the 32 MB request limit
const FREQ = ["Once daily","Twice daily","Three times daily","Every morning","At bedtime","As needed","Weekly","Monthly","Other"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "The ANTHROPIC_API_KEY secret isn't set in Supabase." }, 500);

  // Act as the signed-in user, so storage rules only allow their own files.
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
  );
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "Please sign in again." }, 401);

  let body: { paths?: string[]; today?: string };
  try { body = await req.json(); } catch { return json({ error: "Bad request." }, 400); }
  const paths = (body.paths ?? []).filter((p) => typeof p === "string" && p.startsWith(user.id + "/")).slice(0, 10);
  if (!paths.length) return json({ error: "No documents to read." }, 400);

  const content: Record<string, unknown>[] = [];
  const skipped: string[] = [];
  let total = 0;
  for (const path of paths) {
    const name = path.split("/").pop() ?? "file";
    const { data, error } = await supabase.storage.from("attachments").download(path);
    if (error || !data) { skipped.push(`${name} (couldn't open)`); continue; }
    const type = data.type || (name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "");
    const isPdf = type === "application/pdf";
    const isImg = IMAGE_TYPES.includes(type);
    if (!isPdf && !isImg) { skipped.push(`${name} (not a photo or PDF)`); continue; }
    if (isImg && data.size > MAX_IMAGE) { skipped.push(`${name} (photo over 5 MB)`); continue; }
    if (total + data.size > MAX_TOTAL) { skipped.push(`${name} (too much to read at once)`); continue; }
    total += data.size;
    const b64 = encodeBase64(new Uint8Array(await data.arrayBuffer()));
    content.push(isPdf
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 }, title: name }
      : { type: "image", source: { type: "base64", media_type: type, data: b64 } });
  }
  if (!content.length) return json({ error: "None of these files could be read.", skipped }, 422);

  const today = /^\d{4}-\d{2}-\d{2}$/.test(body.today ?? "") ? body.today : new Date().toISOString().slice(0, 10);
  content.push({ type: "text", text: `These are documents a patient uploaded to their personal health record (visit summary, receipt or bill, lab or imaging report, dental or vision record, prescription, or similar). Today's date is ${today}.

Return ONLY a JSON object with exactly these keys. Use "" (or null for cost, [] for lists) when the documents don't say. Never guess or invent.
{
 "cat": one of "medical","dental","vision","lab","pharmacy","therapy","other",
 "date": visit or service date as "YYYY-MM-DD",
 "title": short reason for visit, 2-6 words (e.g. "Annual physical", "Dental cleaning", "CT abdomen"),
 "provider": the treating clinician's name with title (e.g. "Dr. Maria Patel, MD"),
 "facility": clinic, practice, lab or hospital name,
 "phone": the facility's phone number,
 "portal": patient portal named on the documents, if any,
 "diagnosis": diagnoses or findings in plain words, ICD or CDT codes in parentheses if shown, semicolon-separated,
 "outcome": treatments, procedures, results and instructions, 1-4 plain sentences,
 "followUp": next appointment or recheck date as "YYYY-MM-DD", only if a specific date is given,
 "cost": amount the PATIENT paid or owes out of pocket (patient responsibility) as a number, not the billed total,
 "summary": 2-5 sentence plain-language summary for the patient's journal, including notable lab values, vitals or imaging impressions,
 "tags": up to 5 short lowercase keywords,
 "medications": [{"name": "", "dose": "", "freq": one of ${JSON.stringify(FREQ)} or the directions as written, "purpose": ""}] for medications newly prescribed or changed
}` });

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-5-5",
      max_tokens: 2000,
      messages: [{ role: "user", content }],
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    console.error("Anthropic error", res.status, detail.slice(0, 500));
    const msg = res.status === 401 ? "The Anthropic API key is invalid."
      : res.status === 429 ? "Too many requests to Claude. Wait a minute and try again."
      : res.status === 400 && /credit/i.test(detail) ? "Your Anthropic account is out of credits."
      : "Claude couldn't read these documents right now. Try again.";
    return json({ error: msg, skipped }, 502);
  }
  const out = await res.json();
  const text: string = (out.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  try {
    const result = JSON.parse(text.slice(start, end + 1));
    return json({ result, skipped });
  } catch {
    return json({ error: "Claude's answer couldn't be understood. Try again.", skipped }, 502);
  }
});
