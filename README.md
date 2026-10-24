# Health Binder

Your own place for medical, dental, and vision records, medications, journal notes, and photos of receipts and paperwork. It doesn't depend on any clinic's patient portal.

- **Netlify** hosts the website.
- **Supabase** stores your records, your login, and your files. Every row and file is locked to your account by Row Level Security.
- **Claude** (through your own Anthropic API key) reads uploaded PDFs and photos to fill in visit details.

Setup takes about 20 minutes and only happens once.

---

## 1. Create the Supabase project

1. Sign up at [supabase.com](https://supabase.com) and click **New project**.
   - Name: `health-binder`
   - Database password: generate one and keep it in your password manager.
   - Region: pick the one closest to you (for Texas, **East US** or **Central US**).
2. When the project is ready, open **SQL Editor → New query**, paste the whole contents of [`supabase/schema.sql`](supabase/schema.sql), and click **Run**. You should see "Success. No rows returned."
   This creates the tables, the privacy rules, and a private `attachments` storage bucket.
3. Open **Project Settings → API** (on newer dashboards, **API Keys**) and copy two values for step 3:
   - **Project URL**, which looks like `https://abcdefgh.supabase.co`
   - The **anon public** key, or the **publishable** key on newer projects

   ⚠️ Never copy the **service_role** or **secret** key anywhere. This site doesn't need it.

## 2. Turn on "Fill in from documents"

1. Get an API key at [console.anthropic.com](https://console.anthropic.com) under **API Keys → Create key**. Add a few dollars of credit under **Billing**. Reading one document usually costs a few cents.
2. In Supabase, open **Edge Functions → Secrets**, click **Add new secret**, and enter:
   - Name `ANTHROPIC_API_KEY`, with your key as the value
3. Open **Edge Functions → Deploy a new function → Via Editor**.
   - Name it exactly `extract`.
   - Replace the sample code with the whole contents of [`supabase/functions/extract/index.ts`](supabase/functions/extract/index.ts).
   - Click **Deploy**. Leave **Verify JWT** turned **on**, so only signed-in users can call it.

4. Do the same for the **Insights** report: **Deploy a new function → Via Editor**, name it exactly `analyze`, paste in the contents of [`supabase/functions/analyze/index.ts`](supabase/functions/analyze/index.ts), and click **Deploy**. It uses the same `ANTHROPIC_API_KEY`. A report usually costs about 5–20 cents, depending on how many records you have.

> Prefer the command line? Run `supabase functions deploy extract` and `supabase functions deploy analyze` from this folder after `supabase link`.

## 3. Deploy on Netlify

1. Sign up at [netlify.com](https://netlify.com) with your GitHub account.
2. Click **Add new site → Import an existing project → GitHub**, then choose **health-binder**.
3. Netlify reads the settings from `netlify.toml`, so leave the build settings as they are.
4. Before deploying, open **Add environment variables** (or later: **Site configuration → Environment variables**) and add:
   - `SUPABASE_URL`, set to your Project URL
   - `SUPABASE_ANON_KEY`, set to your anon or publishable key
5. Click **Deploy**. You'll get an address like `https://something.netlify.app`. You can rename it under **Site configuration → Change site name**, for example to `jstovall-health.netlify.app`.

If you added the variables after the first deploy, go to **Deploys → Trigger deploy → Deploy site**.

## 4. Point Supabase logins at your site

In Supabase, open **Authentication → URL Configuration**:

- **Site URL**: your Netlify address, for example `https://jstovall-health.netlify.app`
- **Redirect URLs**: add the same address

This makes the confirmation and password-reset emails link back to your site.

## 5. Create your login, then lock the door

1. Open your site and choose **Create a login**. Confirm your email from the link Supabase sends you.
2. **Important:** in Supabase, open **Authentication → Sign In / Providers**, then under **Email** (or **User Signups**) turn **off "Allow new users to sign up."** That way nobody else can create an account on your binder.
3. Optional but recommended: use a long, unique password from a password manager.

## 6. Bring over your records from the Claude version

1. In the Claude version of Health Binder, go to **Backup → Download full backup** and save the `.json` file.
2. On your new site, go to **Backup & account → Restore from a backup** and choose that file. Entries, medications, and attachments are all restored.

---

## Insights reports

The **Insights** tab asks Claude to review your records for a time period (the last 12 months, the last 3 years, or everything), with an optional focus such as "my knee" or "dental costs". The report covers:

- things to follow up on soon, or to call a doctor about
- patterns across your visits
- medication questions to ask your pharmacist
- overdue follow-ups and routine care that may be due
- out-of-pocket spending by type, calculated exactly from your entries
- questions to bring to your next appointment, with a button to copy them
- information you could add to make the binder more useful

Reports are saved, so you can compare them over time. They're written by an AI from your own records. They aren't medical advice, so talk with your providers before acting on anything.

**Already set up before Insights existed?** Run `supabase/schema.sql` again in the SQL Editor. It's safe to re-run, and it adds the `reports` table. Then deploy the `analyze` function as described in step 2.

## Keeping your data safe

- **Backups.** Download a backup now and then from **Backup & account**. It's a `.zip` with all your records (`records.json`, plus `visits.csv` for Excel) and every attachment in its original form.
- **Free plan pausing.** Supabase pauses free projects after about a week with no activity. Your data is kept, and you can resume the project from the Supabase dashboard. Logging in every week or so avoids it.
- **Who can see what.** The site address and anon key are public by design. Your records are protected by your login and the database rules in `schema.sql`, so other people who find the site only see the sign-in page.
- **Large imaging studies.** Files can be up to 50 MB each. A full CT or MRI study (hundreds of DICOM files) is better kept on a cloud drive, with its location noted in the visit entry.

## Making changes

Every change pushed to the `main` branch on GitHub redeploys the site automatically. The code is plain HTML, CSS, and JavaScript in `public/`, with no build tools needed.

To run it on your own computer, copy `public/config.example.js` to `public/config.js`, fill in your values, and serve the `public` folder with any static server (for example `npx serve public`). Also add `http://localhost:3000` to the Supabase Redirect URLs.

## Files

| Path | What it is |
| --- | --- |
| `public/` | The website: `index.html`, `app.js`, `style.css` |
| `supabase/schema.sql` | Tables, privacy rules, and the storage bucket. Run once. |
| `supabase/functions/extract/` | Reads documents with Claude for "Fill in from documents" |
| `supabase/functions/analyze/` | Writes the Insights report with Claude and saves it |
| `scripts/write-config.mjs` | Netlify build step that writes `public/config.js` from your environment variables |
| `netlify.toml` | Netlify build settings and security headers |
