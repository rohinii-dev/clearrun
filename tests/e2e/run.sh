#!/bin/bash
# Full browser + API regression against a stand-in Supabase (no real keys needed).
# Needs: Node 20+, and Playwright with Chromium (npm i -D playwright && npx playwright install chromium)
cd "$(dirname "$0")/../.."
MOCK_PORT=54321 node tests/e2e/mock-supabase.mjs >/dev/null 2>&1 & MOCK=$!
SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SERVICE_ROLE_KEY=test PORT=5599 node server.mjs >/dev/null 2>&1 & APP=$!
sleep 1.5
node tests/e2e/regression.cjs http://localhost:5599; CODE=$?
kill $MOCK $APP 2>/dev/null
exit $CODE
