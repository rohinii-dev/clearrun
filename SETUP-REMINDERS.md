# Invoice scanning and payment reminders: setup

1. Supabase → SQL Editor: paste `supabase/reminders.sql`, Run (once).
2. Vercel → Project → Settings → Environment Variables (Production), add:
   - `GEMINI_API_KEY` (or `ANTHROPIC_API_KEY`) for invoice scanning.
   - `RESEND_API_KEY` and `RESEND_FROM` (e.g. `ClearRun <onboarding@resend.dev>` while testing; that sender can only email your own Resend address).
   - `CRON_SECRET`: any long random string.
   - `REMINDER_TEST_TO`: your own email. While set, every automatic reminder goes to you.
   - `REMINDER_LIVE`: leave unset (dry run) until ready, then `true`.
3. Redeploy: `npx vercel --prod`. Check `/api/health`: `invoiceScanning` and `reminderEmails` show what is set up.

Never put these keys in index.html, GitHub or chat.
