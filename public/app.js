/* Health Binder — personal health records on Supabase.
   Records live in your own Supabase project; every row and file is locked to your login. */
(() => {
"use strict";

const CFG = window.HB_CONFIG || {};
const CATS = {
  medical:{label:"Medical", c:"--c-medical"},
  dental:{label:"Dental", c:"--c-dental"},
  vision:{label:"Vision", c:"--c-vision"},
  lab:{label:"Lab / Imaging", c:"--c-lab"},
  pharmacy:{label:"Pharmacy", c:"--c-pharmacy"},
  therapy:{label:"Therapy / Rehab", c:"--c-therapy"},
  other:{label:"Other / Journal", c:"--c-other"},
};
const FREQ = ["Once daily","Twice daily","Three times daily","Every morning","At bedtime","As needed","Weekly","Monthly","Other"];
const BUCKET = "attachments";
const MAX_FILE = 50 * 1024 * 1024;
const JSZIP = "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js";

const $ = (s, el=document) => el.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const cc = k => `style="--cc:var(${(CATS[k]||CATS.other).c})"`;
const todayISO = () => { const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; };
const parseD = s => { if(!s) return null; const [y,m,d]=String(s).slice(0,10).split("-").map(Number); return new Date(y,m-1,d); };
const fmtD = s => { const d=parseD(s); return d ? d.toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"}) : ""; };
const money = n => (n==null||n===""||isNaN(n)) ? "" : Number(n).toLocaleString(undefined,{style:"currency",currency:"USD"});
const kb = n => n>1048576 ? (n/1048576).toFixed(1)+" MB" : Math.max(1,Math.round(n/1024))+" KB";
const extOf = name => ((name||"").split(".").pop()||"file").slice(0,4);
const isImg = t => /^image\/(jpeg|png|gif|webp|avif|bmp)$/.test(t||"");
const isPdf = (t,n) => t==="application/pdf" || /\.pdf$/i.test(n||"");
const nn = v => (v===""||v==null) ? null : v;     // empty → null for date/number columns
const safeName = n => (n||"file").normalize("NFKD").replace(/[^\w.\- ]+/g,"").replace(/\s+/g,"-").slice(-80) || "file";

function toast(msg){ const t=document.createElement("div"); t.className="toast"; t.textContent=msg; document.body.appendChild(t); setTimeout(()=>t.remove(),3000); }

/* ---------- Supabase ---------- */
if(!window.supabase){
  $("#main").innerHTML = `<div class="notice"><strong>Couldn't load the app.</strong> Check your internet connection and reload the page.</div>`;
  return;
}
if(!CFG.supabaseUrl || !CFG.supabaseKey){
  $("#main").innerHTML = `<div class="notice"><strong>Setup isn't finished.</strong> The site doesn't know which Supabase project to use. In Netlify, add the SUPABASE_URL and SUPABASE_ANON_KEY environment variables, then redeploy. See the README for the steps.</div>`;
  return;
}
const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, { auth:{ persistSession:true, autoRefreshToken:true, detectSessionInUrl:true } });

let user=null, entries=[], meds=[], files=[];
let tab="visits", catFilter="all", provFilter=null, q="";

/* Row ⇄ app model */
const entryFromRow = r => ({ id:r.id, cat:r.cat, date:r.date||"", title:r.title||"", provider:r.provider||"", facility:r.facility||"", phone:r.phone||"", portal:r.portal||"",
  diagnosis:r.diagnosis||"", outcome:r.outcome||"", followUp:r.follow_up||"", cost:r.cost==null?null:Number(r.cost), notes:r.notes||"", tags:r.tags||[], created:r.created_at });
const entryToRow = e => ({ cat:e.cat, date:nn(e.date), title:e.title, provider:e.provider, facility:e.facility, phone:e.phone, portal:e.portal,
  diagnosis:e.diagnosis, outcome:e.outcome, follow_up:nn(e.followUp), cost:nn(e.cost), notes:e.notes, tags:e.tags||[] });
const medFromRow = r => ({ id:r.id, name:r.name, dose:r.dose||"", freq:r.freq||"", purpose:r.purpose||"", prescriber:r.prescriber||"", pharmacy:r.pharmacy||"",
  startDate:r.start_date||"", endDate:r.end_date||"", notes:r.notes||"", created:r.created_at });
const medToRow = m => ({ name:m.name, dose:m.dose, freq:m.freq, purpose:m.purpose, prescriber:m.prescriber, pharmacy:m.pharmacy,
  start_date:nn(m.startDate), end_date:nn(m.endDate), notes:m.notes });
const fileFromRow = r => ({ id:r.id, entryId:r.entry_id, name:r.name, type:r.type, size:Number(r.size)||0, path:r.path, thumb:r.thumb, created:r.created_at });

async function loadAll(){
  const [e,m,f] = await Promise.all([
    sb.from("entries").select("*").order("date",{ascending:false,nullsFirst:false}),
    sb.from("meds").select("*"),
    sb.from("files").select("*").order("created_at"),
  ]);
  const err = e.error||m.error||f.error;
  if(err){ toast(err.message.includes("does not exist") ? "The database tables are missing. Run supabase/schema.sql (see README)." : "Couldn't load your records. Check your connection."); console.error(err); }
  entries=(e.data||[]).map(entryFromRow); meds=(m.data||[]).map(medFromRow); files=(f.data||[]).map(fileFromRow);
  render();
}

/* ---------- Auth ---------- */
let recovering=false;
sb.auth.onAuthStateChange((event, session) => {
  if(event==="PASSWORD_RECOVERY"){ recovering=true; showNewPassword(); return; }
  const u = session?.user || null;
  if(recovering) return;
  if(u && (!user || u.id!==user.id)){ user=u; $("#topbar").hidden=false; loadAll(); }
  else if(!u){ user=null; entries=[]; meds=[]; files=[]; reports=null; currentReport=null; showSignIn(); }
});
sb.auth.getSession().then(({data}) => { if(!data.session && !recovering) showSignIn(); });

function authShell(inner){
  $("#topbar").hidden=true; close();
  $("#main").innerHTML = `<div class="auth">${inner}</div>`;
}
function showSignIn(mode="in"){
  const up = mode==="up";
  authShell(`<h1>Health Binder</h1><p>${up?"Create your login. Use an email you'll always have access to.":"Sign in to your records."}</p>
    <form id="af" novalidate>
      <div class="f"><label for="a-email">Email</label><input id="a-email" type="email" autocomplete="email" required></div>
      <div class="f"><label for="a-pass">Password</label><input id="a-pass" type="password" autocomplete="${up?"new-password":"current-password"}" minlength="8" required>${up?`<span class="hint">At least 8 characters.</span>`:""}</div>
      <p class="err" id="a-err" role="alert"></p>
      <button class="btn primary" type="submit" id="a-go">${up?"Create account":"Sign in"}</button>
    </form>
    <div class="links">${up?`<button class="linkbtn" id="a-switch" type="button">I already have a login</button>`:`<button class="linkbtn" id="a-switch" type="button">Create a login</button><button class="linkbtn" id="a-forgot" type="button">Forgot password?</button>`}</div>`);
  $("#a-switch").onclick=()=>showSignIn(up?"in":"up");
  const fg=$("#a-forgot"); if(fg) fg.onclick=showForgot;
  $("#af").onsubmit=async ev=>{
    ev.preventDefault();
    const email=$("#a-email").value.trim(), password=$("#a-pass").value, errEl=$("#a-err"), go=$("#a-go");
    if(!email||!password){ errEl.textContent="Enter your email and password."; return; }
    go.disabled=true; errEl.textContent="";
    const {data,error} = up ? await sb.auth.signUp({email,password,options:{emailRedirectTo:location.origin}}) : await sb.auth.signInWithPassword({email,password});
    go.disabled=false;
    if(error){ errEl.textContent = /signups? not allowed|disabled/i.test(error.message) ? "New logins are turned off for this binder." : /invalid login/i.test(error.message) ? "That email and password don't match." : error.message; return; }
    if(up && !data.session) authShell(`<h1>Check your email</h1><p>We sent a confirmation link to <b>${esc(email)}</b>. Open it on this device to finish creating your login.</p><button class="btn" id="a-back" type="button">Back to sign in</button>`), $("#a-back").onclick=()=>showSignIn();
  };
}
function showForgot(){
  authShell(`<h1>Reset password</h1><p>We'll email you a link to set a new password.</p>
    <form id="ff" novalidate><div class="f"><label for="r-email">Email</label><input id="r-email" type="email" autocomplete="email" required></div>
    <p class="err" id="r-err" role="alert"></p><button class="btn primary" type="submit">Send reset link</button></form>
    <div class="links"><button class="linkbtn" id="r-back" type="button">Back to sign in</button></div>`);
  $("#r-back").onclick=()=>showSignIn();
  $("#ff").onsubmit=async ev=>{
    ev.preventDefault(); const email=$("#r-email").value.trim(); if(!email) return;
    const {error}=await sb.auth.resetPasswordForEmail(email,{redirectTo:location.origin});
    if(error){ $("#r-err").textContent=error.message; return; }
    authShell(`<h1>Check your email</h1><p>If ${esc(email)} has a login, a reset link is on its way.</p><button class="btn" id="r-done" type="button">Back to sign in</button>`); $("#r-done").onclick=()=>showSignIn();
  };
}
function showNewPassword(){
  authShell(`<h1>New password</h1><p>Choose a new password for your binder.</p>
    <form id="np" novalidate><div class="f"><label for="n-pass">New password</label><input id="n-pass" type="password" autocomplete="new-password" minlength="8" required><span class="hint">At least 8 characters.</span></div>
    <p class="err" id="n-err" role="alert"></p><button class="btn primary" type="submit">Save password</button></form>`);
  $("#np").onsubmit=async ev=>{
    ev.preventDefault(); const password=$("#n-pass").value;
    if(password.length<8){ $("#n-err").textContent="Use at least 8 characters."; return; }
    const {data,error}=await sb.auth.updateUser({password});
    if(error){ $("#n-err").textContent=error.message; return; }
    recovering=false; history.replaceState(null,"",location.pathname); toast("Password saved");
    user=data.user; $("#topbar").hidden=false; loadAll();
  };
}

/* ---------- Tabs ---------- */
document.querySelectorAll(".tabs button").forEach(b => b.addEventListener("click", () => { tab=b.dataset.tab; render(); }));
$("#q").addEventListener("input", e => { q=e.target.value.trim().toLowerCase(); if(tab!=="visits"&&tab!=="meds") tab="visits"; render(); });
$("#newBtn").addEventListener("click", () => tab==="meds" ? openMedEditor() : openEntryEditor());

/* ---------- Render ---------- */
function render(){
  if(!user) return;
  document.querySelectorAll(".tabs button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab===tab)));
  $("#newBtn").textContent = tab==="meds" ? "+ Add medication" : "+ New entry";
  const m = $("#main");
  m.innerHTML = tab==="visits" ? viewVisits() : tab==="meds" ? viewMeds() : tab==="providers" ? viewProviders() : tab==="insights" ? viewInsights() : viewBackup();
  wire();
}
const filesFor = eid => files.filter(f=>f.entryId===eid);
const hay = e => [e.title,e.provider,e.facility,e.diagnosis,e.outcome,e.notes,(e.tags||[]).join(" "),CATS[e.cat]?.label].join(" ").toLowerCase();
const fileTile = f => f.thumb ? `<img src="${f.thumb}" alt="">` : `<span class="ext">${esc(isPdf(f.type,f.name)?"pdf":extOf(f.name))}</span>`;

function viewVisits(){
  const now = todayISO(), yr = String(new Date().getFullYear());
  const thisYear = entries.filter(e=>(e.date||"").startsWith(yr));
  const spent = thisYear.reduce((s,e)=>s+(Number(e.cost)||0),0);
  const spentAll = entries.reduce((s,e)=>s+(Number(e.cost)||0),0);
  const lastVisit = entries.map(e=>e.date||"").filter(d=>d&&d<=now).sort().pop();
  const activeMeds = meds.filter(x=>!x.endDate || x.endDate>=now).length;
  const next = entries.filter(e=>e.followUp && e.followUp>=now).sort((a,b)=>a.followUp.localeCompare(b.followUp))[0];
  const summary = `<div class="summary">
    <div><div class="k">Entries</div><div class="v">${entries.length}</div><div class="s">${thisYear.length} in ${yr}${lastVisit?` · last ${esc(fmtD(lastVisit))}`:""}</div></div>
    <div><div class="k">Out-of-pocket cost</div><div class="v">${money(spentAll)||"$0.00"}</div><div class="s">${money(spent)||"$0.00"} in ${yr}</div></div>
    <div><div class="k">Active medications</div><div class="v">${activeMeds}</div><div class="s">${meds.length-activeMeds} past</div></div>
    <div><div class="k">Next follow-up</div><div class="v">${next?esc(fmtD(next.followUp)):"—"}</div><div class="s">${next?esc(next.provider||next.title||""):"none scheduled"}</div></div>
  </div>`;
  if(!entries.length) return summary + `<div class="empty"><h3>Start your binder</h3><p>Log a doctor or dentist visit, a lab result, or a journal note. Add photos of receipts and paperwork, and upload a visit summary PDF to have the details filled in for you. Moving from the Claude version? Restore your backup on the Backup &amp; account tab.</p><button class="btn primary" data-new type="button">+ Add your first entry</button></div>`;

  const byProv = provFilter ? entries.filter(e=>e.provider===provFilter || e.facility===provFilter) : entries;
  const counts = {}; byProv.forEach(e=>counts[e.cat]=(counts[e.cat]||0)+1);
  if(catFilter!=="all" && !counts[catFilter]) catFilter="all";
  const chips = `<div class="chips">
    <button class="chip" data-cat="all" aria-pressed="${catFilter==="all"}">All <span class="mono">${byProv.length}</span></button>
    ${Object.entries(CATS).filter(([k])=>counts[k]).map(([k,v])=>`<button class="chip" data-cat="${k}" aria-pressed="${catFilter===k}" ${cc(k)}><span class="dot"></span>${v.label} <span class="mono">${counts[k]}</span></button>`).join("")}
    ${provFilter?`<span class="filter-note">Provider: <b>${esc(provFilter)}</b> <button class="btn ghost" data-clear-prov type="button">Clear</button></span>`:""}
  </div>`;
  let list = byProv.slice();
  if(catFilter!=="all") list = list.filter(e=>e.cat===catFilter);
  if(q) list = list.filter(e=>hay(e).includes(q));
  list.sort((a,b)=>(b.date||"").localeCompare(a.date||"") || String(b.created).localeCompare(String(a.created)));
  if(!list.length) return summary + chips + `<div class="empty"><h3>No matches</h3><p>${q?`Nothing matches “${esc(q)}”${provFilter||catFilter!=="all"?" with the filters you've chosen":""}.`:"Nothing fits these filters."}</p><button class="btn" data-clear-all type="button">Show all entries</button></div>`;

  const byYear = {};
  list.forEach(e=>{ const y=(e.date||"Undated").slice(0,4); (byYear[y]=byYear[y]||[]).push(e); });
  return summary + chips + Object.keys(byYear).sort((a,b)=>b.localeCompare(a)).map(y=>`<section class="year"><h2 class="mono">${esc(y)}</h2><div class="entries">${byYear[y].map(cardEntry).join("")}</div></section>`).join("");
}
function cardEntry(e){
  const d=parseD(e.date), fs=filesFor(e.id), where=[e.provider,e.facility].filter(Boolean).join(" · ");
  const thumbs = fs.slice(0,3).map(fileTile).join("") + (fs.length>3?`<span class="ext">+${fs.length-3}</span>`:"");
  return `<button class="entry" type="button" data-open="${e.id}" ${cc(e.cat)}>
    <div class="d">${d?`<b>${d.getDate()}</b>${d.toLocaleDateString(undefined,{month:"short"})}`:"—"}</div>
    <div style="min-width:0">
      <div class="cat-label">${esc(CATS[e.cat]?.label||"Other")}</div>
      <p class="t">${esc(e.title||"Untitled entry")}</p>
      <div class="meta">${where?`<span>${esc(where)}</span>`:""}${e.diagnosis?`<span>Dx: ${esc(e.diagnosis)}</span>`:""}${e.cost?`<span class="mono">${money(e.cost)}</span>`:""}${e.followUp?`<span>Follow-up ${esc(fmtD(e.followUp))}</span>`:""}</div>
      ${(e.outcome||e.notes)?`<div class="out">${esc(e.outcome||e.notes)}</div>`:""}
    </div>
    ${fs.length?`<div class="thumbs">${thumbs}</div>`:"<div></div>"}
  </button>`;
}
function viewMeds(){
  const now=todayISO();
  let list=meds.slice();
  if(q) list=list.filter(m=>[m.name,m.dose,m.purpose,m.prescriber,m.pharmacy,m.notes].join(" ").toLowerCase().includes(q));
  const on = m => !m.endDate || m.endDate>=now;
  const act=list.filter(on).sort((a,b)=>a.name.localeCompare(b.name)), past=list.filter(m=>!on(m)).sort((a,b)=>b.endDate.localeCompare(a.endDate));
  const head=`<div class="section-head"><div><h2>Medications</h2><p>What you take now and what you've taken before, with dose and who prescribed it.</p></div></div>`;
  if(!meds.length) return head+`<div class="empty"><h3>No medications yet</h3><p>Add prescriptions, over-the-counter meds, and supplements. Having the full list handy makes new-patient forms and pharmacy calls much easier.</p><button class="btn primary" data-newmed type="button">+ Add medication</button></div>`;
  const card=m=>`<button class="med" type="button" data-med="${m.id}">
    <div style="min-width:0"><div class="n">${esc(m.name)}</div><div class="dose">${esc([m.dose,m.freq].filter(Boolean).join(" · "))}</div>
    <div class="meta">${esc([m.purpose&&("For "+m.purpose), m.prescriber&&("Rx: "+m.prescriber), m.startDate&&("Since "+fmtD(m.startDate)), m.endDate&&("Ended "+fmtD(m.endDate))].filter(Boolean).join(" · "))}</div></div>
    <span class="state ${on(m)?"on":"off"}">${on(m)?"Taking":"Stopped"}</span></button>`;
  return head+`<div class="sub">Currently taking · ${act.length}</div><div class="list">${act.map(card).join("")||`<p class="progress">None.</p>`}</div>`+(past.length?`<div class="sub">Past · ${past.length}</div><div class="list">${past.map(card).join("")}</div>`:"");
}
function viewProviders(){
  const map=new Map();
  entries.forEach(e=>{
    const key=e.provider||e.facility; if(!key) return;
    const p=map.get(key)||{name:key,facility:"",phone:"",portal:"",cats:new Set(),n:0,last:""};
    p.n++; p.cats.add(e.cat); if(e.facility&&e.facility!==key) p.facility=e.facility; if(e.phone) p.phone=e.phone; if(e.portal) p.portal=e.portal;
    if((e.date||"")>p.last) p.last=e.date; map.set(key,p);
  });
  const ps=[...map.values()].sort((a,b)=>b.last.localeCompare(a.last));
  const head=`<div class="section-head"><div><h2>Providers</h2><p>Every doctor, dentist, and clinic you've logged, built from your entries. Select one to see its visits.</p></div></div>`;
  if(!ps.length) return head+`<div class="empty"><h3>No providers yet</h3><p>Providers appear here once you log a visit with a doctor or clinic name.</p></div>`;
  return head+`<div class="scroll-x"><table class="prov-table"><thead><tr><th>Provider</th><th>Type</th><th>Phone</th><th>Visits</th><th>Last seen</th></tr></thead><tbody>
    ${ps.map(p=>`<tr data-prov="${esc(p.name)}"><td><b>${esc(p.name)}</b>${p.facility?`<div class="progress">${esc(p.facility)}</div>`:""}${p.portal?`<div class="progress">Portal: ${esc(p.portal)}</div>`:""}</td>
    <td>${[...p.cats].map(c=>`<span class="cat-label" ${cc(c)}>${esc(CATS[c]?.label||"Other")}</span>`).join("<br>")}</td>
    <td class="mono" style="user-select:all">${esc(p.phone)}</td><td class="mono">${p.n}</td><td class="mono">${esc(fmtD(p.last))}</td></tr>`).join("")}</tbody></table></div>`;
}
function viewBackup(){
  const bytes=files.reduce((s,f)=>s+(f.size||0),0);
  return `<div class="section-head"><div><h2>Backup &amp; account</h2><p>Your binder lives in your own Supabase project. Keep a copy on your computer too.</p></div></div>
  <div class="panel"><h3>Download a backup</h3><p>${entries.length} entries, ${meds.length} medications, ${files.length} attachments (${kb(bytes)}). Downloads a .zip with a records file and every attachment in its original form.</p>
    <div class="row"><button class="btn primary" id="exp" type="button">Download backup</button><span class="progress" id="exp-status"></span></div><div class="bar-progress" id="exp-bar" hidden><i></i></div></div>
  <div class="panel"><h3>Restore from a backup</h3><p>Choose a .zip backup from this site, or the .json backup you downloaded from the Claude version of Health Binder. Records are added to what's already here.</p>
    <div class="row"><input type="file" id="importFile" accept=".zip,.json,application/zip,application/json"><span class="progress" id="imp-status"></span></div><div class="bar-progress" id="imp-bar" hidden><i></i></div></div>
  <div class="panel"><h3>Account</h3><p>Signed in as <b>${esc(user.email)}</b>.</p><div class="row"><button class="btn" id="signout" type="button">Sign out</button></div></div>`;
}
function wire(){
  const m=$("#main");
  m.querySelectorAll("[data-cat]").forEach(b=>b.onclick=()=>{catFilter=b.dataset.cat;render();});
  m.querySelectorAll("[data-open]").forEach(b=>b.onclick=()=>openEntry(b.dataset.open));
  m.querySelectorAll("[data-med]").forEach(b=>b.onclick=()=>openMedEditor(meds.find(x=>x.id===b.dataset.med)));
  m.querySelectorAll("[data-prov]").forEach(r=>r.onclick=()=>{provFilter=r.dataset.prov;catFilter="all";tab="visits";render();});
  m.querySelectorAll("[data-new]").forEach(b=>b.onclick=()=>openEntryEditor());
  m.querySelectorAll("[data-newmed]").forEach(b=>b.onclick=()=>openMedEditor());
  const cp=m.querySelector("[data-clear-prov]"); if(cp) cp.onclick=()=>{provFilter=null;render();};
  const ca=m.querySelector("[data-clear-all]"); if(ca) ca.onclick=()=>{provFilter=null;catFilter="all";q="";$("#q").value="";render();};
  const ex=$("#exp"); if(ex) ex.onclick=exportZip;
  const imp=$("#importFile"); if(imp) imp.onchange=()=>imp.files[0]&&importBackup(imp.files[0]);
  const so=$("#signout"); if(so) so.onclick=()=>sb.auth.signOut();
  if(tab==="insights") wireInsights();
}

/* ---------- Insights (analysis reports) ---------- */
let reports=null, reportsLoading=false, currentReport=null, running=false, runStatus="", runRange="12m", runFocus="";
const RANGE_OPTS=[["12m","Last 12 months"],["3y","Last 3 years"],["all","All records"]];
const fmtDT = s => s ? new Date(s).toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"}) : "";

async function loadReports(){
  if(reportsLoading) return; reportsLoading=true;
  const {data,error}=await sb.from("reports").select("*").order("created_at",{ascending:false}).limit(50);
  reportsLoading=false;
  if(error){ reports=[]; if(/does not exist/.test(error.message)) runStatus="Reports need the updated database setup. Run supabase/schema.sql again (see README)."; }
  else { reports=data; if(!currentReport && data.length) currentReport=data[0]; }
  if(tab==="insights") render();
}

function viewInsights(){
  if(reports===null){ loadReports(); }
  const head=`<div class="section-head"><div><h2>Insights</h2><p>Claude reviews your visits, medications, and notes and points out patterns, follow-ups, costs, and questions worth asking.</p></div></div>`;
  const form=`<div class="panel run">
    <div class="grid2">
      <div class="f"><label for="r-range">Look at</label><select id="r-range">${RANGE_OPTS.map(([v,l])=>`<option value="${v}" ${v===runRange?"selected":""}>${l}</option>`).join("")}</select></div>
      <div class="f"><label for="r-focus">Anything specific? <span class="hint">Optional</span></label><input id="r-focus" maxlength="300" value="${esc(runFocus)}" placeholder="My knee, dental costs, blood pressure…"></div>
    </div>
    <div class="row" style="margin-top:12px"><button class="btn primary" id="r-run" type="button" ${running?"disabled":""}>${running?"Analyzing…":"Run analysis"}</button><span class="progress" id="r-status">${esc(runStatus)}</span></div>
  </div>`;
  const history = reports&&reports.length>1 ? `<div class="sub">Earlier reports</div><div class="list">${reports.map(r=>`<button class="med hist" type="button" data-report="${r.id}" ${currentReport&&currentReport.id===r.id?'aria-current="true"':""}>
      <div style="min-width:0"><div class="n" style="font-size:14px">${esc(r.result?.headline||"Report")}</div><div class="meta">${esc(fmtDT(r.created_at))} · ${esc(r.range_label)}${r.focus?` · “${esc(r.focus)}”`:""}</div></div><span class="state off">View</span></button>`).join("")}</div>` : "";
  const body = currentReport ? renderReport(currentReport)
    : reports===null ? `<div class="notice">Loading your reports…</div>`
    : `<div class="empty"><h3>No reports yet</h3><p>Pick a time period and run your first analysis. It usually takes under a minute, and the report is saved here so you can come back to it.</p></div>`;
  return head+form+body+history;
}

function renderReport(rep){
  const r=rep.result||{}, st=rep.stats||{};
  const list=(arr,fn)=>Array.isArray(arr)&&arr.length?arr.map(fn).join(""):"";
  const item=x=>`<li><b>${esc(x.title)}</b>${x.when?` <span class="when">${esc(x.when)}</span>`:""}<div>${esc(x.detail)}</div></li>`;
  const section=(title,inner)=>inner?`<section class="rsec"><h3>${title}</h3>${inner}</section>`:"";
  const maxCost=Math.max(1,...(st.byType||[]).map(t=>t.cost||0));
  const bars=(st.byType||[]).filter(t=>t.visits).map(t=>`<div class="rbar"><span>${esc(t.type)}</span><div class="track"><i style="width:${Math.round((t.cost||0)/maxCost*100)}%"></i></div><span class="mono">${money(t.cost)||"$0.00"}</span><span class="mono muted">${t.visits} visit${t.visits===1?"":"s"}</span></div>`).join("");
  const flags=list(r.flags,f=>`<div class="flag ${["urgent","soon"].includes(f.level)?f.level:"note"}"><span class="lvl">${f.level==="urgent"?"Contact your doctor":f.level==="soon"?"Follow up soon":"Note"}</span><b>${esc(f.title)}</b><div>${esc(f.detail)}</div></div>`);
  const qs=Array.isArray(r.questions)?r.questions:[];
  return `<article class="report" id="report">
    <div class="rhead"><div class="meta">${esc(fmtDT(rep.created_at))} · ${esc(rep.range_label||st.range||"")}${rep.focus?` · Focus: ${esc(rep.focus)}`:""}</div>
      <h2>${esc(r.headline||"Your health binder report")}</h2>
      <div class="row">${rep.id?`<button class="btn ghost" id="r-del" type="button">Delete report</button>`:""}</div></div>
    <div class="summary" style="margin-bottom:18px">
      <div><div class="k">Entries</div><div class="v">${st.entries??0}</div><div class="s">${st.providers??0} providers</div></div>
      <div><div class="k">Out-of-pocket</div><div class="v">${money(st.totalCost)||"$0.00"}</div><div class="s">${esc(st.range||"")}</div></div>
      <div><div class="k">Medications</div><div class="v">${st.activeMeds??0}</div><div class="s">${st.pastMeds??0} past</div></div>
      <div><div class="k">Follow-ups</div><div class="v">${(st.overdueFollowUps||[]).length}</div><div class="s">overdue · ${(st.upcomingFollowUps||[]).length} upcoming</div></div>
    </div>
    ${flags?`<div class="flags">${flags}</div>`:""}
    ${section("Overview", r.overview?`<p>${esc(r.overview)}</p>`:"")}
    ${section("Patterns", list(r.patterns,item)&&`<ul>${list(r.patterns,item)}</ul>`)}
    ${section("Medications", list(r.medications,item)&&`<ul>${list(r.medications,item)}</ul>`)}
    ${section("Care &amp; follow-ups", list(r.care,item)&&`<ul>${list(r.care,item)}</ul>`)}
    ${section("Spending", (r.spending?`<p>${esc(r.spending)}</p>`:"")+(bars?`<div class="rbars">${bars}</div>`:""))}
    ${section("Questions for your next visit", qs.length?`<ol class="qs">${qs.map(q=>`<li>${esc(q)}</li>`).join("")}</ol><button class="btn" id="r-copy" type="button">Copy questions</button>`:"")}
    ${section("To make your binder more useful", Array.isArray(r.gaps)&&r.gaps.length?`<ul class="plain">${r.gaps.map(g=>`<li>${esc(g)}</li>`).join("")}</ul>`:"")}
    <p class="disclaimer">This report was written by Claude from the records in your binder. It can miss things or get things wrong, and it isn't medical advice. Talk with your doctor, dentist, or pharmacist before making any health decision. For an emergency, call 911.</p>
    <div id="r-delconf"></div>
  </article>`;
}

function wireInsights(){
  const run=$("#r-run"); if(run) run.onclick=runAnalysis;
  document.querySelectorAll("[data-report]").forEach(b=>b.onclick=()=>{ currentReport=reports.find(r=>r.id===b.dataset.report); render(); $("#report")?.scrollIntoView({behavior:"smooth",block:"start"}); });
  const cp=$("#r-copy"); if(cp) cp.onclick=async()=>{
    const qs=(currentReport.result?.questions||[]).map((q,i)=>`${i+1}. ${q}`).join("\n");
    try{ await navigator.clipboard.writeText(qs); toast("Questions copied"); }catch{ const r=document.createRange(); r.selectNodeContents($(".qs")); getSelection().removeAllRanges(); getSelection().addRange(r); toast("Selected. Press Ctrl+C or Cmd+C to copy."); }
  };
  const del=$("#r-del"); if(del) del.onclick=()=>{
    $("#r-delconf").innerHTML=`<div class="confirm"><span style="flex:1">Delete this report? Your records aren't affected.</span><button class="btn" id="rd-no" type="button">Keep it</button><button class="btn danger solid" id="rd-yes" type="button">Delete</button></div>`;
    $("#rd-no").onclick=()=>$("#r-delconf").innerHTML="";
    $("#rd-yes").onclick=async()=>{
      const id=currentReport.id; const {error}=await sb.from("reports").delete().eq("id",id);
      if(error){ toast("Couldn't delete. Try again."); return; }
      reports=reports.filter(r=>r.id!==id); currentReport=reports[0]||null; toast("Report deleted"); render();
    };
  };
}

async function runAnalysis(){
  if(running) return;
  const range=runRange=$("#r-range").value, focus=runFocus=$("#r-focus").value.trim();
  running=true; runStatus="Claude is reviewing your records. This usually takes under a minute."; render();
  try{
    const {data,error}=await sb.functions.invoke("analyze",{body:{range,focus,today:todayISO()}});
    if(error){ let m=""; try{ m=(await error.context?.json())?.error; }catch{} throw new Error(m || (/not found|404/i.test(error.message)?"The analysis isn't set up yet. Deploy the analyze function (see README).":"Couldn't reach the analysis service. Try again.")); }
    currentReport=data.report;
    if(data.saved) reports=[data.report,...(reports||[])];
    runStatus=data.saved?"":"The report couldn't be saved. Run supabase/schema.sql again to add the reports table.";
  }catch(err){ runStatus=err.message||"Something went wrong. Try again."; }
  running=false;
  if(tab==="insights"){ render(); if(!runStatus) $("#report")?.scrollIntoView({behavior:"smooth",block:"start"}); }
  else if(!runStatus) toast("Your Insights report is ready");
}

/* ---------- Sheets ---------- */
let onClose=null;
function sheet(html, cleanup){
  onClose=cleanup||null;
  const layer=$("#layer");
  layer.innerHTML=`<div class="scrim"><div class="sheet" role="dialog" aria-modal="true">${html}</div></div>`;
  const scrim=layer.firstChild;
  scrim.addEventListener("mousedown",e=>{ if(e.target===scrim) close(); });
  layer.querySelectorAll("[data-close]").forEach(b=>b.onclick=()=>close());
  document.addEventListener("keydown",esck);
  return scrim.firstChild;
}
function esck(e){ if(e.key==="Escape" && !$(".viewer")) close(); }
function close(saved){ const c=onClose; onClose=null; if(c && !saved) c(); $("#layer").innerHTML=""; document.removeEventListener("keydown",esck); }

function openEntry(id){
  const e=entries.find(x=>x.id===id); if(!e) return;
  const fs=filesFor(id), row=(k,v)=>v?`<dt>${k}</dt><dd>${esc(v)}</dd>`:"";
  const s=sheet(`<div class="detail">
    <div class="sheet-head"><div style="flex:1;min-width:0"><div class="cat-label" ${cc(e.cat)}>${esc(CATS[e.cat]?.label||"Other")} · <span class="mono">${esc(fmtD(e.date))}</span></div><h2>${esc(e.title||"Untitled entry")}</h2></div><button class="x" data-close aria-label="Close">×</button></div>
    <dl>${row("Provider",e.provider)}${row("Facility",e.facility)}${row("Phone",e.phone)}${row("Patient portal",e.portal)}${row("Diagnosis",e.diagnosis)}${row("Outcome",e.outcome)}${row("Follow-up",fmtD(e.followUp))}${e.cost!=null?`<dt>Out-of-pocket cost</dt><dd class="mono">${money(e.cost)}</dd>`:""}</dl>
    ${e.notes?`<div class="sub" style="margin-top:0">Notes</div><div class="journal">${esc(e.notes)}</div>`:""}
    ${(e.tags||[]).length?`<div class="tags" style="margin-bottom:16px">${e.tags.map(t=>`<span class="tag">#${esc(t)}</span>`).join("")}</div>`:""}
    ${fs.length?`<div class="sub">Attachments · ${fs.length}</div><div class="files" style="margin-bottom:16px">${fs.map(f=>`<button class="file" type="button" data-view="${f.id}">${fileTile(f)}<div class="nm">${esc(f.name)}</div></button>`).join("")}</div>`:""}
    <div class="foot" id="foot"><button class="btn danger" id="del" type="button">Delete</button><div class="row"><button class="btn" data-close type="button">Close</button><button class="btn primary" id="edit" type="button">Edit</button></div></div>
  </div>`);
  s.querySelectorAll("[data-view]").forEach(b=>b.onclick=()=>viewFile(files.find(f=>f.id===b.dataset.view)));
  $("#edit",s).onclick=()=>openEntryEditor(e);
  $("#del",s).onclick=()=>{
    $("#foot",s).innerHTML=`<div class="confirm" style="width:100%"><span style="flex:1">Delete this entry${fs.length?` and its ${fs.length} attachment${fs.length>1?"s":""}`:""}? This can't be undone.</span><button class="btn" id="no" type="button">Keep it</button><button class="btn danger solid" id="yes" type="button">Delete</button></div>`;
    $("#no",s).onclick=()=>openEntry(id);
    $("#yes",s).onclick=async()=>{
      $("#yes",s).disabled=true;
      if(fs.length) await sb.storage.from(BUCKET).remove(fs.map(f=>f.path));
      const {error}=await sb.from("entries").delete().eq("id",id);
      if(error){ toast("Couldn't delete. Try again."); $("#yes",s).disabled=false; return; }
      close(true); toast("Entry deleted"); loadAll();
    };
  };
}

/* ---------- Uploading ---------- */
function loadImg(file){ return new Promise((res,rej)=>{ const u=URL.createObjectURL(file); const i=new Image(); i.onload=()=>{res(i);URL.revokeObjectURL(u);}; i.onerror=()=>{rej();URL.revokeObjectURL(u);}; i.src=u; }); }
function drawJpeg(img,max,q){ const r=Math.min(1,max/Math.max(img.naturalWidth,img.naturalHeight)); const c=document.createElement("canvas"); c.width=Math.round(img.naturalWidth*r); c.height=Math.round(img.naturalHeight*r); const x=c.getContext("2d"); x.fillStyle="#fff"; x.fillRect(0,0,c.width,c.height); x.drawImage(img,0,0,c.width,c.height); return c; }
const canvasBlob = (c,q) => new Promise(r=>c.toBlob(r,"image/jpeg",q));

/* Uploads one file now (so Claude can read it before the entry is saved). Returns the pending record. */
async function uploadFile(file){
  if(file.size>MAX_FILE) throw new Error(`${file.name} is over 50 MB. Store very large files (like full CT studies) in a cloud drive and note where in the entry.`);
  let blob=file, name=file.name, type=file.type||"application/octet-stream", thumb=null;
  if(file.type.startsWith("image/")){
    try{
      const img=await loadImg(file);
      thumb=drawJpeg(img,320).toDataURL("image/jpeg",.7);
      // Phone photos over 5 MB (or formats Claude can't read) get a high-quality JPEG copy instead
      if(file.size>4.5*1048576 || !isImg(file.type)){ blob=await canvasBlob(drawJpeg(img,3000),.88); type="image/jpeg"; name=name.replace(/\.[^.]+$/,"")+".jpg"; }
    }catch{ /* browser can't decode (e.g. HEIC on some computers): keep the original, no preview */ }
  }
  const id=crypto.randomUUID(), path=`${user.id}/${id}/${safeName(name)}`;
  const {error}=await sb.storage.from(BUCKET).upload(path, blob, {contentType:type, upsert:false});
  if(error) throw new Error(/exceeded|too large/i.test(error.message)?`${file.name} is too large to upload.`:`Couldn't upload ${file.name}. ${error.message}`);
  return {id, name, type, size:blob.size, path, thumb};
}

/* ---------- Entry editor ---------- */
function openEntryEditor(e){
  const isNew=!e; e=e||{cat:"medical",date:todayISO()};
  const existing=isNew?[]:filesFor(e.id);
  let pending=[], removed=new Set(), foundMeds=[];
  const provs=[...new Set(entries.map(x=>x.provider).filter(Boolean))], facs=[...new Set(entries.map(x=>x.facility).filter(Boolean))];
  // If the sheet closes without saving, remove files that were uploaded for it
  const s=sheet(`<form id="ef" novalidate>
    <div class="sheet-head"><h2>${isNew?"New entry":"Edit entry"}</h2><button class="x" type="button" data-close aria-label="Close">×</button></div>
    <div class="grid2">
      <div class="f full"><label>Type</label><div class="catpick">${Object.entries(CATS).map(([k,v])=>`<label ${cc(k)}><input type="radio" name="cat" value="${k}" ${e.cat===k?"checked":""}><span class="dot"></span><span>${v.label}</span></label>`).join("")}</div></div>
      <div class="f"><label for="f-date">Date visited</label><input id="f-date" type="date" value="${esc(e.date)}" required></div>
      <div class="f"><label for="f-title">Reason / title</label><input id="f-title" value="${esc(e.title)}" placeholder="Annual physical, cleaning, knee pain…"></div>
      <div class="f"><label for="f-prov">Doctor / provider</label><input id="f-prov" list="dl-prov" value="${esc(e.provider)}" placeholder="Dr. Patel"></div>
      <div class="f"><label for="f-fac">Clinic / facility</label><input id="f-fac" list="dl-fac" value="${esc(e.facility)}" placeholder="Plano Family Dental"></div>
      <div class="f"><label for="f-phone">Phone</label><input id="f-phone" type="tel" value="${esc(e.phone)}" placeholder="(972) 555-0100"></div>
      <div class="f"><label for="f-portal">Patient portal used</label><input id="f-portal" value="${esc(e.portal)}" placeholder="MyChart, FollowMyHealth…"></div>
      <div class="f full"><label for="f-dx">Diagnosis</label><input id="f-dx" value="${esc(e.diagnosis)}" placeholder="What they found"></div>
      <div class="f full"><label for="f-out">Outcome / treatment</label><textarea id="f-out" style="min-height:70px" placeholder="What was done, what they prescribed, next steps">${esc(e.outcome)}</textarea></div>
      <div class="f"><label for="f-fu">Follow-up date</label><input id="f-fu" type="date" value="${esc(e.followUp)}"></div>
      <div class="f"><label for="f-cost">Out-of-pocket cost (USD)</label><input id="f-cost" type="number" inputmode="decimal" step="0.01" min="0" value="${e.cost??""}" placeholder="0.00"></div>
      <div class="f full"><label for="f-notes">Notes / journal</label><textarea id="f-notes" placeholder="How you felt, questions you asked, what the doctor said, anything to remember…">${esc(e.notes)}</textarea></div>
      <div class="f full"><label for="f-tags">Tags</label><input id="f-tags" value="${esc((e.tags||[]).join(", "))}" placeholder="insurance, knee, allergy"><span class="hint">Separate with commas.</span></div>
      <div class="f full"><label>Photos &amp; documents</label>
        <div class="drop" id="drop" tabindex="0" role="button">Add photos of receipts, prescriptions, diagnosis paperwork, PDFs, or other files<br><span class="hint">Tap to choose, or drop files here. Up to 50 MB each, kept at full quality.</span></div>
        <input type="file" id="fin" multiple hidden>
        <div class="files" id="flist"></div>
        <div class="ai" id="ai" hidden><button class="btn" type="button" id="aiBtn">Fill in from documents</button><span class="progress" id="aiMsg">Claude reads your photos and PDFs and fills in the empty fields for you to check.</span></div>
        <div id="found"></div></div>
    </div>
    <datalist id="dl-prov">${provs.map(p=>`<option value="${esc(p)}">`).join("")}</datalist>
    <datalist id="dl-fac">${facs.map(p=>`<option value="${esc(p)}">`).join("")}</datalist>
    <div class="foot" style="margin-top:16px"><span class="progress" id="prog"></span><div class="row"><button class="btn" type="button" data-close>Cancel</button><button class="btn primary" id="save" type="submit">Save entry</button></div></div>
  </form>`, () => { if(pending.length) sb.storage.from(BUCKET).remove(pending.map(p=>p.path)); });

  const flist=$("#flist",s), prog=$("#prog",s);
  const drawFiles=()=>{
    flist.innerHTML = existing.filter(f=>!removed.has(f.id)).map(f=>`<div class="file">${fileTile(f)}<div class="nm">${esc(f.name)}</div><button type="button" class="rm" data-rmx="${f.id}" aria-label="Remove ${esc(f.name)}">×</button></div>`).join("")
      + pending.map((p,i)=>`<div class="file">${fileTile(p)}<div class="nm">${esc(p.name)} · new</div><button type="button" class="rm" data-rmp="${i}" aria-label="Remove ${esc(p.name)}">×</button></div>`).join("");
    flist.querySelectorAll("[data-rmx]").forEach(b=>b.onclick=()=>{removed.add(b.dataset.rmx);drawFiles();});
    flist.querySelectorAll("[data-rmp]").forEach(b=>b.onclick=()=>{ const [p]=pending.splice(+b.dataset.rmp,1); sb.storage.from(BUCKET).remove([p.path]); drawFiles(); });
    const readable=[...pending,...existing.filter(f=>!removed.has(f.id))].filter(f=>isImg(f.type)||isPdf(f.type,f.name));
    $("#ai",s).hidden = !readable.length;
  };
  drawFiles();
  const fin=$("#fin",s), drop=$("#drop",s);
  const addFiles=async list=>{
    $("#save",s).disabled=true;
    for(const file of list){
      prog.textContent=`Uploading ${file.name}…`;
      try{ pending.push(await uploadFile(file)); }catch(err){ toast(err.message); }
      drawFiles();
    }
    prog.textContent=""; $("#save",s).disabled=false;
  };
  drop.onclick=()=>fin.click(); drop.onkeydown=ev=>{ if(ev.key==="Enter"||ev.key===" "){ev.preventDefault();fin.click();} };
  fin.onchange=()=>{ addFiles([...fin.files]); fin.value=""; };
  drop.ondragover=ev=>{ev.preventDefault();drop.classList.add("over");}; drop.ondragleave=()=>drop.classList.remove("over");
  drop.ondrop=ev=>{ev.preventDefault();drop.classList.remove("over");addFiles([...ev.dataTransfer.files]);};

  const touched={date:!isNew,cat:!isNew};
  $("#f-date",s).addEventListener("input",()=>touched.date=true);
  s.querySelectorAll('input[name="cat"]').forEach(r=>r.addEventListener("change",()=>touched.cat=true));
  s.addEventListener("input",ev=>ev.target.classList?.remove("filled"));

  $("#aiBtn",s).onclick=async()=>{
    const btn=$("#aiBtn",s), msg=$("#aiMsg",s); btn.disabled=true;
    const paths=[...pending,...existing.filter(f=>!removed.has(f.id))].filter(f=>isImg(f.type)||isPdf(f.type,f.name)).map(f=>f.path);
    msg.textContent="Claude is reading the documents… this can take up to a minute.";
    try{
      const {data,error}=await sb.functions.invoke("extract",{body:{paths,today:todayISO()}});
      if(error){ let m=""; try{ m=(await error.context?.json())?.error; }catch{} throw new Error(m || (/not found|404/i.test(error.message)?"The document reader isn't set up yet. Deploy the extract function (see README).":"Couldn't reach the document reader. Try again.")); }
      const r=data.result||{};
      const n=applyExtract(r,s,touched);
      foundMeds=(Array.isArray(r.medications)?r.medications:[]).filter(m=>m&&m.name);
      $("#found",s).innerHTML=foundMeds.length?`<div class="found"><div class="sub" style="margin:0 0 4px">Prescriptions found · add to Medications when you save</div>${foundMeds.map((m,i)=>`<label class="chk"><input type="checkbox" data-fm="${i}" checked><span><b>${esc(m.name)}</b> ${esc([m.dose,m.freq].filter(Boolean).join(" · "))}${m.purpose?` <span class="progress">for ${esc(m.purpose)}</span>`:""}</span></label>`).join("")}</div>`:"";
      const sk=(data.skipped||[]).length?` Skipped: ${data.skipped.join(", ")}.`:"";
      msg.textContent=(n||foundMeds.length?`Filled ${n} field${n===1?"":"s"} (outlined). Check them before saving. Fields you'd already typed weren't changed.`:"Claude couldn't find visit details in these files. You can fill them in by hand.")+sk;
    }catch(err){ msg.textContent=err.message||"Something went wrong. Try again."; }
    btn.disabled=false;
  };

  $("#ef",s).onsubmit=async ev=>{
    ev.preventDefault();
    const v=id=>$(id,s).value.trim();
    if(!v("#f-date")){ toast("Add the date of the visit."); $("#f-date",s).focus(); return; }
    const data={ cat:(s.querySelector('input[name="cat"]:checked')||{}).value||"other", date:v("#f-date"), title:v("#f-title"), provider:v("#f-prov"), facility:v("#f-fac"),
      phone:v("#f-phone"), portal:v("#f-portal"), diagnosis:v("#f-dx"), outcome:v("#f-out"), followUp:v("#f-fu"), cost:v("#f-cost")===""?null:Number(v("#f-cost")),
      notes:$("#f-notes",s).value, tags:v("#f-tags").split(",").map(t=>t.trim().replace(/^#/,"")).filter(Boolean) };
    const btn=$("#save",s); btn.disabled=true; prog.textContent="Saving…";
    try{
      let id=e.id;
      if(isNew){ const r=await sb.from("entries").insert(entryToRow(data)).select("id").single(); if(r.error) throw r.error; id=r.data.id; }
      else { const r=await sb.from("entries").update(entryToRow(data)).eq("id",id); if(r.error) throw r.error; }
      if(removed.size){
        const gone=existing.filter(f=>removed.has(f.id));
        await sb.storage.from(BUCKET).remove(gone.map(f=>f.path));
        await sb.from("files").delete().in("id",gone.map(f=>f.id));
      }
      if(pending.length){
        const r=await sb.from("files").insert(pending.map(p=>({id:p.id,entry_id:id,name:p.name,type:p.type,size:p.size,path:p.path,thumb:p.thumb})));
        if(r.error) throw r.error;
      }
      const addMeds=foundMeds.filter((m,i)=>s.querySelector(`[data-fm="${i}"]`)?.checked);
      if(addMeds.length){
        await sb.from("meds").insert(addMeds.map(m=>medToRow({name:String(m.name),dose:String(m.dose||""),freq:FREQ.includes(m.freq)?m.freq:"",purpose:String(m.purpose||""),
          prescriber:data.provider,pharmacy:"",startDate:data.date,endDate:"",notes:[m.freq&&!FREQ.includes(m.freq)?`Directions: ${m.freq}`:"",`Added from ${data.title||"visit"} on ${fmtD(data.date)}.`].filter(Boolean).join("\n")})));
      }
      pending=[]; close(true);
      toast((isNew?"Entry saved":"Changes saved")+(addMeds.length?` · ${addMeds.length} medication${addMeds.length>1?"s":""} added`:""));
      loadAll();
    }catch(err){ console.error(err); btn.disabled=false; prog.textContent=""; toast("Couldn't save. Check your connection and try again."); }
  };
  setTimeout(()=>$("#f-title",s).focus(),50);
}

function applyExtract(r,s,touched){
  if(!r||typeof r!=="object") return 0;
  let n=0;
  const put=(sel,val,force)=>{ const el=$(sel,s); if(!el||val==null) return; val=String(val).trim(); if(!val) return; if(!force&&el.value.trim()) return; el.value=val; el.classList.add("filled"); n++; };
  const isDate=v=>typeof v==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(v);
  if(isDate(r.date)) put("#f-date",r.date,!touched.date);
  if(r.cat&&CATS[r.cat]&&!touched.cat){ const radio=s.querySelector(`input[name="cat"][value="${r.cat}"]`); if(radio){radio.checked=true;n++;} }
  put("#f-title",r.title); put("#f-prov",r.provider); put("#f-fac",r.facility); put("#f-phone",r.phone); put("#f-portal",r.portal);
  put("#f-dx",r.diagnosis); put("#f-out",r.outcome);
  if(isDate(r.followUp)) put("#f-fu",r.followUp);
  if(typeof r.cost==="number"&&r.cost>=0) put("#f-cost",r.cost.toFixed(2));
  if(r.summary){ const notes=$("#f-notes",s); if(!notes.value.includes(r.summary)){ notes.value=(notes.value.trim()?notes.value.trim()+"\n\n":"")+"From the paperwork: "+r.summary; notes.classList.add("filled"); n++; } }
  if(Array.isArray(r.tags)&&r.tags.length) put("#f-tags",r.tags.slice(0,5).join(", "));
  return n;
}

/* ---------- Medication editor ---------- */
function openMedEditor(m){
  const isNew=!m; m=m||{startDate:todayISO()};
  const s=sheet(`<form id="mf" novalidate>
    <div class="sheet-head"><h2>${isNew?"Add medication":esc(m.name)}</h2><button class="x" type="button" data-close aria-label="Close">×</button></div>
    <div class="grid2">
      <div class="f"><label for="m-name">Medication</label><input id="m-name" value="${esc(m.name)}" placeholder="Lisinopril" required></div>
      <div class="f"><label for="m-dose">Dose</label><input id="m-dose" value="${esc(m.dose)}" placeholder="10 mg tablet"></div>
      <div class="f"><label for="m-freq">How often</label><select id="m-freq"><option value="">Choose…</option>${FREQ.map(f=>`<option ${m.freq===f?"selected":""}>${f}</option>`).join("")}</select></div>
      <div class="f"><label for="m-purpose">What it's for</label><input id="m-purpose" value="${esc(m.purpose)}" placeholder="Blood pressure"></div>
      <div class="f"><label for="m-rx">Prescribed by</label><input id="m-rx" value="${esc(m.prescriber)}" placeholder="Dr. Patel"></div>
      <div class="f"><label for="m-ph">Pharmacy &amp; Rx number</label><input id="m-ph" value="${esc(m.pharmacy)}" placeholder="CVS Legacy Dr · Rx 4410293"></div>
      <div class="f"><label for="m-start">Started</label><input id="m-start" type="date" value="${esc(m.startDate)}"></div>
      <div class="f"><label for="m-end">Stopped</label><input id="m-end" type="date" value="${esc(m.endDate)}"><span class="hint">Leave empty if you're still taking it.</span></div>
      <div class="f full"><label for="m-notes">Notes</label><textarea id="m-notes" style="min-height:80px" placeholder="Side effects, why it was stopped, refill reminders…">${esc(m.notes)}</textarea></div>
    </div>
    <div class="foot" style="margin-top:16px" id="mfoot">${isNew?"<span></span>":`<button class="btn danger" type="button" id="mdel">Delete</button>`}<div class="row"><button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="submit" id="msave">Save</button></div></div>
  </form>`);
  $("#mf",s).onsubmit=async ev=>{
    ev.preventDefault();
    const v=id=>$(id,s).value.trim();
    if(!v("#m-name")){ toast("Add the medication name."); $("#m-name",s).focus(); return; }
    const row=medToRow({name:v("#m-name"),dose:v("#m-dose"),freq:v("#m-freq"),purpose:v("#m-purpose"),prescriber:v("#m-rx"),pharmacy:v("#m-ph"),startDate:v("#m-start"),endDate:v("#m-end"),notes:$("#m-notes",s).value});
    $("#msave",s).disabled=true;
    const {error}=isNew?await sb.from("meds").insert(row):await sb.from("meds").update(row).eq("id",m.id);
    if(error){ $("#msave",s).disabled=false; toast("Couldn't save. Try again."); return; }
    close(true); toast("Medication saved"); loadAll();
  };
  const del=$("#mdel",s);
  if(del) del.onclick=()=>{
    $("#mfoot",s).innerHTML=`<div class="confirm" style="width:100%"><span style="flex:1">Delete ${esc(m.name)}? To keep it in your history, set a Stopped date instead.</span><button class="btn" type="button" id="mno">Keep it</button><button class="btn danger solid" type="button" id="myes">Delete</button></div>`;
    $("#mno",s).onclick=()=>openMedEditor(m);
    $("#myes",s).onclick=async()=>{ const {error}=await sb.from("meds").delete().eq("id",m.id); if(error){toast("Couldn't delete. Try again.");return;} close(true); toast("Medication deleted"); loadAll(); };
  };
  setTimeout(()=>$("#m-name",s).focus(),50);
}

/* ---------- Viewing a file ---------- */
async function viewFile(f){
  if(!f) return;
  const v=document.createElement("div"); v.className="viewer";
  v.innerHTML=`<div class="bar"><span>${esc(f.name)} · ${kb(f.size||0)}</span><a class="btn" id="vdl" hidden>Download</a><button class="btn" type="button" id="vclose">Close</button></div><div class="stage"><span class="progress" style="color:#cfd">Loading…</span></div>`;
  document.body.appendChild(v);
  const shut=()=>{v.remove();document.removeEventListener("keydown",k);}; const k=e=>{if(e.key==="Escape")shut();};
  document.addEventListener("keydown",k); $("#vclose",v).onclick=shut;
  const [view,dl]=await Promise.all([sb.storage.from(BUCKET).createSignedUrl(f.path,3600), sb.storage.from(BUCKET).createSignedUrl(f.path,3600,{download:f.name})]);
  const stage=$(".stage",v);
  if(view.error){ stage.innerHTML=`<span class="progress" style="color:#fcc">This attachment couldn't be loaded.</span>`; return; }
  const a=$("#vdl",v); a.href=dl.data?.signedUrl||view.data.signedUrl; a.hidden=false;
  const url=view.data.signedUrl;
  if(f.type?.startsWith("image/")) stage.innerHTML=`<img src="${url}" alt="${esc(f.name)}">`;
  else if(isPdf(f.type,f.name)) stage.innerHTML=`<iframe title="${esc(f.name)}" src="${url}"></iframe>`;
  else stage.innerHTML=`<span class="progress" style="color:#cfd">This file type can't be previewed here. Use Download to open it on your device.</span>`;
}

/* ---------- Backup ---------- */
let zipLib=null;
function loadZip(){ return zipLib||(zipLib=new Promise((res,rej)=>{ const s=document.createElement("script"); s.src=JSZIP; s.onload=()=>res(window.JSZip); s.onerror=()=>{zipLib=null;rej(new Error("zip"));}; document.head.appendChild(s); })); }
const bar=(id,frac)=>{ const b=$(id); if(!b) return; b.hidden=frac==null; b.firstChild.style.width=Math.round((frac||0)*100)+"%"; };

async function exportZip(){
  const st=$("#exp-status"), btn=$("#exp"); btn.disabled=true;
  try{
    const JSZip=await loadZip(), zip=new JSZip();
    const fileName=f=>`attachments/${f.id.slice(0,8)}-${safeName(f.name)}`;
    zip.file("records.json", JSON.stringify({app:"health-binder",version:2,exported:new Date().toISOString(),
      entries, meds, files:files.map(f=>({id:f.id,entryId:f.entryId,name:f.name,type:f.type,size:f.size,file:fileName(f)}))},null,2));
    let csv="date,type,title,provider,facility,diagnosis,outcome,follow_up,out_of_pocket,notes\n";
    const q=v=>`"${String(v??"").replace(/"/g,'""')}"`;
    entries.slice().sort((a,b)=>(a.date||"").localeCompare(b.date||"")).forEach(e=>csv+=[e.date,CATS[e.cat]?.label,e.title,e.provider,e.facility,e.diagnosis,e.outcome,e.followUp,e.cost??"",e.notes].map(q).join(",")+"\n");
    zip.file("visits.csv", csv);
    for(let i=0;i<files.length;i++){
      st.textContent=`Adding attachment ${i+1} of ${files.length}…`; bar("#exp-bar",i/files.length);
      const {data,error}=await sb.storage.from(BUCKET).download(files[i].path);
      if(!error) zip.file(fileName(files[i]), data);
    }
    st.textContent="Building the .zip…";
    const blob=await zip.generateAsync({type:"blob"});
    const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=`health-binder-${todayISO()}.zip`; document.body.appendChild(a); a.click();
    setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},2000);
    st.textContent="Backup downloaded."; toast("Backup downloaded");
  }catch(e){ console.error(e); st.textContent="Couldn't create the backup. Try again."; }
  bar("#exp-bar",null); btn.disabled=false;
}

function dataURLtoBlob(u){ const [h,b]=u.split(","); const mime=(h.match(/data:([^;]+)/)||[])[1]||"application/octet-stream"; const bin=atob(b); const a=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++)a[i]=bin.charCodeAt(i); return new Blob([a],{type:mime}); }
async function thumbFor(blob,type){ if(!type?.startsWith("image/")) return null; try{ const img=await loadImg(blob); return drawJpeg(img,320).toDataURL("image/jpeg",.7); }catch{ return null; } }

async function importBackup(file){
  const st=$("#imp-status");
  try{
    let data, getFile;
    if(/\.zip$/i.test(file.name) || file.type.includes("zip")){
      const JSZip=await loadZip(); const zip=await JSZip.loadAsync(file);
      const rec=zip.file("records.json"); if(!rec) throw new Error("bad");
      data=JSON.parse(await rec.async("string"));
      getFile=async f=>{ const z=f.file&&zip.file(f.file); return z?new Blob([await z.async("arraybuffer")],{type:f.type||""}):null; };
    } else {
      data=JSON.parse(await file.text());     // backup from the Claude version (attachments embedded as data URLs)
      getFile=async f=>f.data?dataURLtoBlob(f.data):null;
    }
    if(data.app!=="health-binder") throw new Error("bad");
    const idMap=new Map(); let n=0;
    for(const e of (data.entries||[])){
      st.textContent=`Restoring entries… ${++n} of ${data.entries.length}`; bar("#imp-bar",n/data.entries.length*.3);
      const row=entryToRow({...e, cat:CATS[e.cat]?e.cat:"other", cost:e.cost===""?null:e.cost});
      const r=await sb.from("entries").insert(row).select("id").single(); if(r.error) throw r.error;
      idMap.set(e.id, r.data.id);
    }
    const medRows=(data.meds||[]).filter(m=>m.name).map(m=>medToRow(m));
    if(medRows.length){ const r=await sb.from("meds").insert(medRows); if(r.error) throw r.error; }
    const fl=(data.files||[]).filter(f=>idMap.has(f.entryId)); let fi=0, missed=0;
    for(const f of fl){
      st.textContent=`Restoring attachment ${++fi} of ${fl.length}…`; bar("#imp-bar",.3+fi/fl.length*.7);
      const blob=await getFile(f); if(!blob){ missed++; continue; }
      const id=crypto.randomUUID(), path=`${user.id}/${id}/${safeName(f.name)}`, type=f.type||blob.type||"application/octet-stream";
      const up=await sb.storage.from(BUCKET).upload(path,blob,{contentType:type}); if(up.error){ missed++; continue; }
      await sb.from("files").insert({id,entry_id:idMap.get(f.entryId),name:f.name,type,size:blob.size,path,thumb:f.thumb||await thumbFor(blob,type)});
    }
    st.textContent=`Restored ${n} entries, ${medRows.length} medications, ${fi-missed} attachments.${missed?` ${missed} attachment${missed>1?"s":""} couldn't be restored.`:""}`;
    loadAll();
  }catch(e){ console.error(e); st.textContent = e.message==="bad"||e instanceof SyntaxError ? "That file isn't a Health Binder backup, or it's damaged." : "The restore stopped partway. Check your connection; records already restored are kept."; }
  bar("#imp-bar",null);
}
})();
