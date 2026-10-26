# ClearRun handoff (v5)

Read README.md first. Key rules for anyone (person or AI assistant) changing this app:

- `index.html` has two scripts. The first is the original app. The second (`ClearRun v5` module, at the end) extends it by wrapping functions (`saveAccountState`, `applyAccountState`, `setView`, `trackedRow`, `enableReminders`, `finishSignIn`, …). Add new behaviour in the second script the same way; it also starts the app (`setView` + `restoreServerSession`).
- Workspace state is one JSON object per workspace (`workspace_states.state`): cash, `flowItems`, `invoices`, `invSettings`, `riskCustomers`, scenario values. Always save through `saveAccountState()`; it sends `baseUpdatedAt` and merges on conflict. Do not PUT `/api/workspace` without `baseUpdatedAt`.
- Every API route is in `lib/api.mjs`, served by `api/index.js` (Vercel) and `server.mjs` (local). Do not add per-route files or `[...path].js`.
- Stage keys in `lib/reminders.mjs` (`before_7` … `over_30`) are stored in `reminder_log`; do not rename them.
- The risk model must stay in step with `customer_risk.py`; `tests/risk-parity.mjs` builds a shared dataset to compare them.
- Never commit `.env`/`.env.local` or print the service role key.
