// Google sign-in end to end through the real handler, with Google's token check simulated,
// plus the single Vercel function's routing. Needs the mock Supabase on MOCK_URL.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
process.env.SUPABASE_URL = process.env.MOCK_URL; process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
process.env.GOOGLE_CLIENT_ID = 'new-client.apps.googleusercontent.com, old-client.apps.googleusercontent.com';
const realFetch = globalThis.fetch;
const tokens = {
  good: { aud: 'new-client.apps.googleusercontent.com', email: 'priya@gmail.com', email_verified: 'true', sub: '1234567890123', name: 'Priya Sharma', exp: String(Math.floor(Date.now() / 1000) + 600) },
  oldId: { aud: 'old-client.apps.googleusercontent.com', email: 'ravi@gmail.com', email_verified: 'true', sub: '99999000001', name: 'Ravi', exp: String(Math.floor(Date.now() / 1000) + 600) },
  wrongAud: { aud: 'someone-else.apps.googleusercontent.com', email: 'x@gmail.com', email_verified: 'true', sub: '5', exp: String(Math.floor(Date.now() / 1000) + 600) },
  unverified: { aud: 'new-client.apps.googleusercontent.com', email: 'y@gmail.com', email_verified: 'false', sub: '6', exp: String(Math.floor(Date.now() / 1000) + 600) }
};
globalThis.fetch = async (url, opts) => {
  const u = new URL(String(url));
  if (u.hostname === 'oauth2.googleapis.com') {
    const t = tokens[u.searchParams.get('id_token')];
    return new Response(JSON.stringify(t || { error: 'invalid_token' }), { status: t ? 200 : 400, headers: { 'Content-Type': 'application/json' } });
  }
  return realFetch(url, opts);
};
const { handleApi, errorResponse } = await import('../lib/api.mjs');
const vercel = (await import('../api/index.js')).default;
const server = createServer(async (req, res) => { try { await handleApi(req, res); } catch (e) { errorResponse(res, e); } }).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const post = async (path, body, cookie) => { const r = await realFetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json(), cookie: (r.headers.get('set-cookie') || '').split(';')[0] }; };
let n = 0;
const first = await post('/api/auth/google', { credential: 'good' });
assert.equal(first.status, 200); assert.equal(first.json.user.email, 'priya@gmail.com'); assert.ok(first.cookie.startsWith('clearrun_session=')); n++;
const again = await post('/api/auth/google', { credential: 'good' });
assert.equal(again.json.user.id, first.json.user.id, 'same Google account maps to the same user'); n++;
const ws = await realFetch(base + '/api/workspace', { headers: { cookie: first.cookie } }); assert.equal(ws.status, 200, 'Google user gets a workspace'); n++;
assert.equal((await post('/api/auth/google', { credential: 'oldId' })).status, 200, 'second (old) client ID in the list is accepted'); n++;
assert.equal((await post('/api/auth/google', { credential: 'wrongAud' })).status, 401, 'token for another app is refused'); n++;
assert.equal((await post('/api/auth/google', { credential: 'unverified' })).status, 401, 'unverified email refused'); n++;
assert.equal((await post('/api/auth/google', { credential: 'garbage' })).status, 401); n++;
assert.equal((await post('/api/auth/google', {})).status, 400); n++;
const cfg = await (await realFetch(base + '/api/config')).json(); assert.equal(cfg.googleClientId, 'new-client.apps.googleusercontent.com', 'browser gets the first ID'); n++;
// Vercel single function: both rewrite styles reach the right route
const call = url => new Promise(resolve => {
  const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(body) { resolve({ status: this.statusCode, body: JSON.parse(body) }); } };
  vercel({ url, method: 'GET', headers: { host: 'x.vercel.app' }, socket: {}, [Symbol.asyncIterator]: async function* () {} }, res);
});
assert.equal((await call('/api/index?__route=health')).body.database, 'ok'); n++;
assert.equal((await call('/api/index?__route=auth/config')).status, 200); n++;
assert.equal((await call('/api/health')).body.database, 'ok', 'works if Vercel passes the original URL'); n++;
assert.equal((await call('/api/index?__route=nope')).status, 404); n++;
server.close();
console.log(`google + routing tests: ${n} passed`);
