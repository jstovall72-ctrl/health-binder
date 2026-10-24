// Health Binder: Insights report
// Reads the signed-in user's own records (Row Level Security applies), works out the
// numbers in code, asks Claude for a plain-language review, saves it, and returns it.
//
// Secrets (Supabase Dashboard → Edge Functions → Secrets):
//   ANTHROPIC_API_KEY          required (same key as the "extract" function)
//   ANTHROPIC_ANALYSIS_MODEL   optional, defaults to ANTHROPIC_MODEL, then claude-sonnet-5-5

import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const LABELS: Record<string, string> = {
  medical: "Medical", dental: "Dental", vision: "Vision", lab: "Lab / Imaging",
  pharmacy: "Pharmacy", therapy: "Therapy / Rehab", other: "Other / Journal",
};
const RANGES: Record<string, { label: string; months: number | null }> = {
  "12m": { label: "Last 12 months", months: 12 },
  "3y": { label: "Last 3 years", months: 36 },
  "all": { label: "All records", months: null },
};
const clip = (s: unknown, n: number) => { const t = String(s ?? "").trim(); return t.length > n ? t.slice(0, n) + "…" : t; };
const round2 = (n: number) => Math.round(n * 100) / 100;

type Entry = { id: string; cat: string; date: string | null; title: string; provider: string; facility: string; diagnosis: string;
  outcome: string; follow_up: string | null; cost: number | string | null; notes: string; tags: string[] };
type Med = { name: string; dose: string; freq: string; purpose: string; prescriber: string; start_date: string | null; end_date: string | null; notes: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "The ANTHROPIC_API_KEY secret isn't set in Supabase." }, 500);

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "Please sign in again." }, 401);

  let body: { range?: string; focus?: string; today?: string };
  try { body = await req.json(); } catch { body = {}; }
  const range = RANGES[body.range ?? "12m"] ?? RANGES["12m"];
  const focus = clip(body.focus, 300);
  const today = /^\d{4}-\d{2}-\d{2}$/.test(body.today ?? "") ? body.today! : new Date().toISOString().slice(0, 10);
  let since: string | null = null;
  if (range.months) { const d = new Date(today + "T00:00:00Z"); d.setUTCMonth(d.getUTCMonth() - range.months); since = d.toISOString().slice(0, 10); }

  // ---- Load the user's records (RLS limits these to their own rows) ----
  let eq = supabase.from("entries").select("id,cat,date,title,provider,facility,diagnosis,outcome,follow_up,cost,notes,tags").order("date", { ascending: true });
  if (since) eq = eq.gte("date", since);
  const [eRes, mRes, allRes] = await Promise.all([
    eq,
    supabase.from("meds").select("name,dose,freq,purpose,prescriber,start_date,end_date,notes"),
    supabase.from("entries").select("cat,date,provider,facility").order("date", { ascending: false }), // for "last seen" across all time
  ]);
  if (eRes.error || mRes.error) return json({ error: "Couldn't read your records." }, 500);
  const entries = (eRes.data ?? []) as Entry[];
  const meds = (mRes.data ?? []) as Med[];
  if (!entries.length && !meds.length) return json({ error: `There are no entries in "${range.label.toLowerCase()}" to analyze yet.` }, 422);

  // ---- Numbers worked out in code, not by the model ----
  const byType: Record<string, { visits: number; cost: number }> = {};
  const byYear: Record<string, number> = {};
  const providers = new Set<string>();
  let total = 0;
  for (const e of entries) {
    const t = byType[e.cat] ??= { visits: 0, cost: 0 };
    t.visits++;
    const c = Number(e.cost) || 0; t.cost += c; total += c;
    if (e.date) byYear[e.date.slice(0, 4)] = (byYear[e.date.slice(0, 4)] ?? 0) + c;
    if (e.provider || e.facility) providers.add(e.provider || e.facility);
  }
  const lastSeen: Record<string, string> = {};
  for (const e of allRes.data ?? []) if (e.date && !lastSeen[e.cat]) lastSeen[e.cat] = e.date;
  const overdue = entries.filter((e) => e.follow_up && e.follow_up < today &&
    !entries.some((x) => x.date && x.date >= e.follow_up! && (x.provider === e.provider || x.facility === e.facility)));
  const upcoming = entries.filter((e) => e.follow_up && e.follow_up >= today);
  const activeMeds = meds.filter((m) => !m.end_date || m.end_date >= today);
  const stats = {
    range: range.label, since, today,
    entries: entries.length, providers: providers.size, activeMeds: activeMeds.length, pastMeds: meds.length - activeMeds.length,
    totalCost: round2(total),
    byType: Object.entries(byType).map(([k, v]) => ({ type: LABELS[k] ?? k, visits: v.visits, cost: round2(v.cost) })).sort((a, b) => b.visits - a.visits),
    costByYear: Object.entries(byYear).sort().map(([year, cost]) => ({ year, cost: round2(cost) })),
    lastSeen: Object.entries(lastSeen).map(([k, d]) => ({ type: LABELS[k] ?? k, date: d })),
    overdueFollowUps: overdue.map((e) => ({ date: e.follow_up, from: `${e.title || LABELS[e.cat]} (${e.date})`, provider: e.provider || e.facility })),
    upcomingFollowUps: upcoming.map((e) => ({ date: e.follow_up, from: `${e.title || LABELS[e.cat]} (${e.date})`, provider: e.provider || e.facility })),
  };

  // ---- Records as compact text for Claude ----
  let budget = 160000;
  const lines: string[] = [];
  for (const e of entries) {
    const line = [
      `[${e.date ?? "undated"}] ${LABELS[e.cat] ?? e.cat}: ${e.title || "(no title)"}`,
      (e.provider || e.facility) && `  Provider: ${[e.provider, e.facility].filter(Boolean).join(", ")}`,
      e.diagnosis && `  Diagnosis: ${clip(e.diagnosis, 400)}`,
      e.outcome && `  Outcome: ${clip(e.outcome, 600)}`,
      e.follow_up && `  Follow-up: ${e.follow_up}`,
      e.cost != null && e.cost !== "" && `  Out of pocket: $${Number(e.cost).toFixed(2)}`,
      e.tags?.length && `  Tags: ${e.tags.join(", ")}`,
      e.notes && `  Notes: ${clip(e.notes, 1500)}`,
    ].filter(Boolean).join("\n");
    if ((budget -= line.length) < 0) { lines.push("[older entries omitted for length]"); break; }
    lines.push(line);
  }
  const medLines = meds.map((m) => `- ${m.name}${m.dose ? ` ${m.dose}` : ""}${m.freq ? `, ${m.freq}` : ""}${m.purpose ? `, for ${m.purpose}` : ""}` +
    `${m.prescriber ? `, prescribed by ${m.prescriber}` : ""}; ${m.start_date ? `started ${m.start_date}` : "start unknown"}; ` +
    `${m.end_date && m.end_date < today ? `STOPPED ${m.end_date}` : "currently taking"}${m.notes ? `. Notes: ${clip(m.notes, 300)}` : ""}`);

  const prompt = `You are reviewing a person's own health records, which they keep in a personal health binder, and writing them a helpful, plain-language report. Today is ${today}. Period covered: ${range.label}${since ? ` (since ${since})` : ""}.
${focus ? `\nThe person asked you to pay special attention to: "${focus}"\n` : ""}
FACTS ALREADY CALCULATED (use these numbers as given; don't recalculate):
${JSON.stringify(stats, null, 1)}

MEDICATIONS (all, current and past):
${medLines.join("\n") || "(none recorded)"}

RECORDS, oldest first:
${lines.join("\n\n") || "(no visits in this period)"}

Guidelines:
- Write to the person directly ("you"), warmly and clearly, at about an 8th-grade reading level. No jargon without a short explanation.
- Base everything on the records. Cite dates like (Mar 14, 2026) when you point to something. Never invent facts, results or diagnoses.
- You are not their doctor. Don't diagnose or change treatment. Point out patterns and suggest what to ask their doctor, dentist or pharmacist.
- If anything in the records could need prompt medical attention (worsening symptoms, a result marked abnormal with no follow-up, a missed follow-up for something serious), put it in "flags" with level "urgent" or "soon" and say who to contact.
- For routine care, use general adult guidelines only as suggestions to confirm with their own providers (e.g. dental cleanings often every 6 months, eye exams every 1–2 years, an annual physical), and only mention one if the records suggest it's due.
- Medications: note possible duplicates, long-running prescriptions with no recent visit to the prescriber, and anything worth reviewing with a pharmacist. Don't state interactions as certain; say "ask your pharmacist whether…".
- Also point out gaps that would make the binder more useful (missing dates, missing doses, visits without an outcome).
- Keep each item short: a bold-worthy title of a few words and 1–3 sentences of detail.

Return ONLY a JSON object with exactly these keys:
{
 "headline": "one sentence summing up the period",
 "overview": "3-5 sentence summary",
 "flags": [{"level": "urgent" | "soon" | "note", "title": "", "detail": ""}],
 "patterns": [{"title": "", "detail": ""}],
 "medications": [{"title": "", "detail": ""}],
 "care": [{"title": "", "detail": "", "when": "e.g. Overdue since Jun 2026 / Due now / Coming up Dec 1"}],
 "spending": "2-3 sentences about out-of-pocket costs using the calculated numbers",
 "questions": ["questions to bring to the next appointment, each naming which provider type to ask"],
 "gaps": ["short suggestions for information to add to the binder"]
}
Use empty arrays where there's nothing worth saying. Prefer fewer, more useful items over many.`;

  const model = Deno.env.get("ANTHROPIC_ANALYSIS_MODEL") || Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-5-5";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 6000, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) {
    const detail = await res.text();
    console.error("Anthropic error", res.status, detail.slice(0, 500));
    const msg = res.status === 401 ? "The Anthropic API key is invalid."
      : res.status === 429 ? "Too many requests to Claude. Wait a minute and try again."
      : res.status === 400 && /credit/i.test(detail) ? "Your Anthropic account is out of credits."
      : "Claude couldn't write the report right now. Try again.";
    return json({ error: msg }, 502);
  }
  const out = await res.json();
  const text: string = (out.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
  let result: Record<string, unknown>;
  try { result = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)); }
  catch { return json({ error: "Claude's report couldn't be understood. Try again." }, 502); }

  const { data: saved, error: saveErr } = await supabase.from("reports")
    .insert({ range_label: range.label, focus, stats, result, model }).select("*").single();
  if (saveErr) console.error("Couldn't save report", saveErr.message);
  return json({ report: saved ?? { id: null, range_label: range.label, focus, stats, result, model, created_at: new Date().toISOString() }, saved: !saveErr });
});
