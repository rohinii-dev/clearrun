# Adding scan + import to another copy of the ClearRun page

`index.html` in the main folder already has everything. Use these files only if your team's page is a different version.

1. Copy into the project: `api/invoice.py`, `api/risk.py`, `api/_risk/customer_risk.py`, the `vendor/` folder.
2. In the page:
   - `import.css` → paste before `</head>`
   - `import.html` (scanner) → inside the Invoices section, plus a button `<button id="scanToggle">Scan invoice</button>`
   - `importdata.html` (import panel) → inside Settings
   - `import.js` → just before `</body>`
3. `import.js` expects these from the page: `flowItems` (list of entries), `inr()`, `escapeHtml()`, `showView()`, and
   `window.crAddItem(item)` / `window.crCommit()` (add an entry / redraw + save). Entries use `dueDate: "YYYY-MM-DD"`.
   For the credit check, send `window.crCustomerData` as `dataset` in the POST to `/api/risk` (see the main README).
