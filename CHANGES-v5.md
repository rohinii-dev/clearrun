# ClearRun v5

Merged the two versions of the app: `clearrun-clean` (invoices, scanning, reminders) and the `clearrun-cash-flow` folder (customer risk, shortfall predictor). No database changes. Run `supabase/reminders.sql` if you have not yet.

## New
- **Google sign-in everywhere**: the Google button sits on the sign-in and sign-up screens. The client ID comes from the server, so `index.html` and the server can never disagree. Clear messages if Google is blocked or not configured.
- **Invoice scanning accuracy**: PDFs as well as photos; photos straightened, sized and contrast-corrected; the model copies values exactly as printed and the server converts them (Indian dates and lakh/crore amounts); total checked against the amount in words and subtotal + GST; GSTIN checksum; buyer/seller swap detection; automatic second reading when something does not add up; uncertain fields highlighted.
- **Reminder ladder**: gentle → formal → legal notice. Preview every email with its date and status, email yourself a test of any step, print the legal notice. The legal notice is never sent automatically without approval.
- **Customer risk** (the team's model): new "Customer risk" page and deal checker; history built from invoices automatically; works in the demo with sample customers; `#customerRisk` links open it.
- **Shortfall chance** in the scenario panel.
- **Team panel** in Settings: create and join invite codes.
- `/api/health` explains exactly what is misconfigured (missing settings, wrong Supabase URL, tables not created).

## Fixed
- Vercel routing: one function serves every API path (the catch-all file never worked on Vercel, which broke `/api/session` and `/api/workspace`).
- Teammates overwriting each other: stale saves are refused and both sets of changes are merged.
- Saving returned a different timestamp than it stored, so the 4-second check reloaded over your typing.
- Customer risk crashed for a new customer classed "Limited credit".
- Greeting was always "Good evening"; the date range was hard-coded.
- Plus everything from v4: sign-out data leak, last edit lost on sign-out, wildcard usernames, rate limits, session writes every 4 seconds, phone check, Origin "null" error.
