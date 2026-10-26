import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { STAGES, buildEmail, ladderPreview, legalNoticeHtml, nextStage, todayIso, validInvoiceForReminder } from './reminders.mjs';
import { extractInvoice, providerName } from './invoice-extract.mjs';
import { predictCashflow, validatePredictionInput } from './predictor.mjs';
import { assessRiskDeal, riskOverview, validateRiskCustomers, withInvoiceHistory } from './customer-risk.mjs';

const COOKIE = 'clearrun_session';
// Keep a remembered sign in active for a year. The expiry is refreshed whenever
// the signed in account makes an authenticated request, until they sign out.
const SESSION_DAYS = 365;
// GOOGLE_CLIENT_ID may hold one client ID or several separated by commas.
// The first one is sent to the browser, so index.html never needs editing.
const FALLBACK_GOOGLE_CLIENT_ID = '75724033338-19u3l9mp9hdb8p6apcut2vih3up0j2tk.apps.googleusercontent.com';
const googleClientIds = () => String(process.env.GOOGLE_CLIENT_ID || FALLBACK_GOOGLE_CLIENT_ID).split(',').map(id => id.trim()).filter(Boolean);
const loginAttempts = new Map();

function config() {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) throw Object.assign(new Error('Backend setup is incomplete. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to the .env file (local) or Vercel environment variables, then restart the server.'), { status: 503, expose: true });
  return { base: base.replace(/\/$/, ''), key };
}

async function db(table, query = {}, options = {}) {
  const { base, key } = config();
  const url = new URL(`${base}/rest/v1/${table}`);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  const headers = {
    apikey: key,
    // Supabase's newer opaque secret keys are API keys, not JWT bearer tokens.
    // Legacy service_role JWTs still need the Authorization header.
    ...(key.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${key}` }),
    Accept: 'application/json',
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.prefer ? { Prefer: options.prefer } : {})
  };
  const response = await fetch(url, {
    method: options.method || 'GET', headers,
    ...(options.body ? { body: JSON.stringify(options.body) } : {})
  });
  const text = await response.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  if (!response.ok) {
    const error = new Error(data?.message || 'Database request failed.');
    error.status = response.status;
    error.detail = data?.details || data?.hint || '';
    throw error;
  }
  return data;
}

function reply(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.end(JSON.stringify(body));
}

async function readBody(req, limit = 256_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Request is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('Request body must be valid JSON.'), { status: 400 }); }
}

function cookieValue(req, name) {
  const cookies = String(req.headers.cookie || '').split(';');
  for (const cookie of cookies) {
    const [key, ...rest] = cookie.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}

function sessionCookie(token, req, clear = false) {
  const secure = req.headers['x-forwarded-proto'] === 'https' || process.env.NODE_ENV === 'production';
  return `${COOKIE}=${clear ? '' : encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`;
}

const digest = value => createHash('sha256').update(value).digest('hex');
function passwordRecord(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
function passwordMatches(password, record = '') {
  const [kind, salt, expectedHex] = record.split('$');
  if (kind !== 'scrypt' || !salt || !expectedHex) return false;
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function cleanUser(user) {
  return { id: user.id, username: user.username, phone: user.phone || '', email: user.email || '', workspaceId: user.workspace_id };
}

async function createWorkspaceForUser(user, workspaceName) {
  const [workspace] = await db('workspaces', {}, {
    method: 'POST', prefer: 'return=representation', body: { name: workspaceName }
  });
  await db('workspace_members', {}, {
    method: 'POST', prefer: 'return=minimal', body: { workspace_id: workspace.id, user_id: user.id, role: 'owner' }
  });
  const [updated] = await db('app_users', { id: `eq.${user.id}` }, {
    method: 'PATCH', prefer: 'return=representation', body: { workspace_id: workspace.id }
  });
  await db('workspace_states', {}, {
    method: 'POST', prefer: 'return=minimal', body: { workspace_id: workspace.id, state: {} }
  });
  return updated;
}

async function newUserSession(user, req, res) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  await db('app_sessions', {}, {
    method: 'POST', prefer: 'return=minimal', body: { token_hash: digest(token), user_id: user.id, expires_at: expiresAt }
  });
  res.setHeader('Set-Cookie', sessionCookie(token, req));
  return cleanUser(user);
}

async function signedInUser(req, res) {
  const token = cookieValue(req, COOKIE);
  if (!token) return null;
  const [session] = await db('app_sessions', {
    token_hash: `eq.${digest(token)}`,
    expires_at: `gt.${new Date().toISOString()}`,
    select: 'user_id,expires_at'
  });
  if (!session) return null;
  const [user] = await db('app_users', { id: `eq.${session.user_id}`, select: 'id,username,phone,email,workspace_id' });
  // Extend the year-long session at most once a day, not on every 4 second poll.
  if (user && Date.parse(session.expires_at) < Date.now() + (SESSION_DAYS - 1) * 86400_000) {
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
    await db('app_sessions', { token_hash: `eq.${digest(token)}` }, {
      method: 'PATCH', prefer: 'return=minimal', body: { expires_at: expiresAt }
    });
    res.setHeader('Set-Cookie', sessionCookie(token, req));
  }
  return user || null;
}

function normalizedPhone(value) { return String(value || '').replace(/\D/g, ''); }

// Usernames are matched exactly (ignoring case). PostgREST treats * % _ as wildcards
// in ilike, so escape them and then confirm the match in code.
const escapeLike = value => String(value).replace(/[\\%_]/g, char => '\\' + char);
async function findUserByName(name, select) {
  if (!name || name.includes('*')) return null;
  const rows = await db('app_users', { username: `ilike.${escapeLike(name)}`, select });
  return rows.find(row => String(row.username).toLowerCase() === name.toLowerCase()) || null;
}

// Per-visitor attempt limits. On Vercel the visitor IP is in x-forwarded-for.
function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || String(req.headers['x-real-ip'] || '') || req.socket?.remoteAddress || 'local';
}
function attemptsFor(key) {
  const now = Date.now();
  if (loginAttempts.size > 5000) for (const [k, v] of loginAttempts) if (v.until < now) loginAttempts.delete(k);
  let attempt = loginAttempts.get(key);
  if (!attempt || attempt.until < now) { attempt = { count: 0, until: now + 60_000 }; loginAttempts.set(key, attempt); }
  return attempt;
}

async function createInvite(user) {
  const code = randomBytes(6).toString('hex').toUpperCase();
  const expiresAt = new Date(Date.now() + 7 * 86400_000).toISOString();
  await db('workspace_invites', {}, {
    method: 'POST', prefer: 'return=minimal', body: {
      code_hash: digest(code), workspace_id: user.workspace_id, created_by: user.id, expires_at: expiresAt
    }
  });
  return { code, expiresAt };
}


const scanAttempts = new Map();

async function memberUser(req, res) {
  const user = await signedInUser(req, res);
  if (!user?.workspace_id) return null;
  const [membership] = await db('workspace_members', { workspace_id: `eq.${user.workspace_id}`, user_id: `eq.${user.id}`, select: 'workspace_id' });
  return membership ? user : null;
}

async function sendEmail({ to, subject, text, html, replyTo }) {
  const key = process.env.RESEND_API_KEY, from = process.env.RESEND_FROM;
  if (!key || !from) throw Object.assign(new Error('Email sending is not set up yet. Add RESEND_API_KEY and RESEND_FROM in the server environment.'), { status: 424 });
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, text, html, ...(replyTo ? { reply_to: replyTo } : {}) })
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    console.error('Resend error', response.status, data?.message || '');
    throw Object.assign(new Error('The email service did not accept this message.' + (response.status === 403 ? ' Check that your sending domain or recipient is allowed.' : '')), { status: 424 });
  }
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method || 'GET';

  if (path === '/api/health' && method === 'GET') {
    // Says exactly which part of the setup is missing, without revealing any secret.
    const report = { ok: false, supabaseSettings: false, database: 'not checked', googleClientId: googleClientIds()[0] || null,
      invoiceScanning: providerName() || 'not set up', reminderEmails: !!(process.env.RESEND_API_KEY && process.env.RESEND_FROM) };
    try { config(); report.supabaseSettings = true; }
    catch (error) { report.database = error.message; return reply(res, 503, report); }
    try { await db('app_users', { select: 'id', limit: '1' }); report.database = 'ok'; report.ok = true; }
    catch (error) {
      report.database = error.status ? `${error.message}${error.status === 404 ? ' (run supabase/schema.sql in the Supabase SQL editor)' : ''}`
        : `Cannot reach Supabase (${error.message}). Check that SUPABASE_URL is exactly your Project URL, e.g. https://abcd.supabase.co`;
    }
    return reply(res, report.ok ? 200 : 503, report);
  }

  if ((path === '/api/config' || path === '/api/auth/config') && method === 'GET') {
    return reply(res, 200, { googleClientId: googleClientIds()[0] || '' });
  }

  if (path.startsWith('/api/') && method !== 'GET' && req.headers.origin) {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    let originHost = '';
    try { originHost = new URL(req.headers.origin).host; } catch { originHost = ''; } // e.g. "null" from a file:// page
    if (originHost !== host) return reply(res, 403, { error: 'Request origin is not allowed.' });
  }

  if (path === '/api/auth/signup' && method === 'POST') {
    const body = await readBody(req);
    const attempt = attemptsFor(`${clientIp(req)}:signup`);
    if (attempt.count >= 20) return reply(res, 429, { error: 'Too many attempts. Wait a minute and try again.' });
    attempt.count += 1;
    const username = String(body.username || '').trim();
    const phone = normalizedPhone(body.phone);
    const password = String(body.password || '');
    if (username.includes('*')) return reply(res, 400, { error: 'Usernames cannot contain the * character.' });
    if (username.length < 2 || username.length > 80 || phone.length < 7 || phone.length > 18 || password.length < 8 || password.length > 200) {
      return reply(res, 400, { error: 'Enter a username, valid phone number and password with at least 8 characters.' });
    }
    const taken = { error: 'That username or phone number is already registered. Sign in instead.' };
    const [existingPhone] = await db('app_users', { phone: `eq.${phone}`, select: 'id' });
    const existingName = await findUserByName(username, 'id,username');
    if (existingPhone || existingName) return reply(res, 409, taken);
    let user;
    try {
      [user] = await db('app_users', {}, {
        method: 'POST', prefer: 'return=representation', body: { username, phone, password_hash: passwordRecord(password) }
      });
    } catch (error) {
      if (error.status === 409) return reply(res, 409, taken); // two sign ups at the same moment
      throw error;
    }
    const saved = await createWorkspaceForUser(user, `${username}'s business`);
    const profile = await newUserSession(saved, req, res);
    return reply(res, 201, { user: profile });
  }

  if (path === '/api/auth/signin' && method === 'POST') {
    const body = await readBody(req);
    const identity = String(body.identity || '').trim();
    const password = String(body.password || '');
    const key = `${clientIp(req)}:signin`;
    const attempt = attemptsFor(key);
    if (attempt.count >= 10) return reply(res, 429, { error: 'Too many sign in attempts. Wait a minute and try again.' });
    const isPhone = normalizedPhone(identity).length >= 7 && /^[\d+() -]+$/.test(identity);
    const select = 'id,username,phone,email,workspace_id,password_hash';
    const user = isPhone
      ? (await db('app_users', { phone: `eq.${normalizedPhone(identity)}`, select }))[0]
      : await findUserByName(identity, select);
    if (!user || !passwordMatches(password, user.password_hash)) {
      attempt.count += 1;
      return reply(res, 401, { error: 'We could not match those details. Check them or create an account.' });
    }
    loginAttempts.delete(key);
    const profile = await newUserSession(user, req, res);
    return reply(res, 200, { user: profile });
  }

  if (path === '/api/auth/google' && method === 'POST') {
    const body = await readBody(req);
    if (!body.credential) return reply(res, 400, { error: 'Google did not return a sign in token.' });
    const verifyUrl = new URL('https://oauth2.googleapis.com/tokeninfo');
    verifyUrl.searchParams.set('id_token', String(body.credential));
    const verified = await fetch(verifyUrl, { headers: { Accept: 'application/json' } });
    if (!verified.ok) return reply(res, 401, { error: 'Google could not verify this account. Try again.' });
    const profile = await verified.json();
    if (!googleClientIds().includes(profile.aud) || profile.email_verified !== 'true' || !profile.sub || !profile.email || Number(profile.exp) <= Date.now() / 1000) {
      return reply(res, 401, { error: 'Google could not verify this account. Try again.' });
    }
    let [user] = await db('app_users', { google_sub: `eq.${profile.sub}`, select: 'id,username,phone,email,workspace_id' });
    if (!user) {
      const username = `${String(profile.name || profile.email.split('@')[0]).slice(0, 64)} ${profile.sub.slice(-5)}`;
      [user] = await db('app_users', {}, {
        method: 'POST', prefer: 'return=representation', body: { username, email: profile.email, google_sub: profile.sub }
      });
      user = await createWorkspaceForUser(user, `${username}'s business`);
    }
    const signedIn = await newUserSession(user, req, res);
    return reply(res, 200, { user: signedIn });
  }

  if (path === '/api/session' && method === 'GET') {
    const user = await signedInUser(req, res);
    return reply(res, user ? 200 : 401, user ? { user: cleanUser(user) } : { user: null });
  }

  if (path === '/api/session' && method === 'DELETE') {
    const token = cookieValue(req, COOKIE);
    if (token) await db('app_sessions', { token_hash: `eq.${digest(token)}` }, { method: 'DELETE' });
    return reply(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', req, true) });
  }

  if (path === '/api/workspace' && method === 'GET') {
    const user = await signedInUser(req, res);
    if (!user) return reply(res, 401, { error: 'Sign in to open this workspace.' });
    if (!user.workspace_id) return reply(res, 409, { error: 'This account has not joined a workspace.' });
    const [membership] = await db('workspace_members', { workspace_id: `eq.${user.workspace_id}`, user_id: `eq.${user.id}`, select: 'workspace_id' });
    if (!membership) return reply(res, 403, { error: 'You are not a member of this workspace.' });
    const [workspace] = await db('workspaces', { id: `eq.${user.workspace_id}`, select: 'id,name' });
    const [stored] = await db('workspace_states', { workspace_id: `eq.${user.workspace_id}`, select: 'state,updated_at' });
    return reply(res, 200, { workspaceId: workspace.id, workspaceName: workspace.name, state: stored?.state || {}, updatedAt: stored?.updated_at || null });
  }

  if (path === '/api/workspace' && method === 'PUT') {
    const user = await signedInUser(req, res);
    if (!user) return reply(res, 401, { error: 'Sign in to save this workspace.' });
    const [membership] = await db('workspace_members', { workspace_id: `eq.${user.workspace_id}`, user_id: `eq.${user.id}`, select: 'workspace_id' });
    if (!membership) return reply(res, 403, { error: 'You are not a member of this workspace.' });
    const body = await readBody(req);
    if (!body.state || typeof body.state !== 'object' || Array.isArray(body.state)) return reply(res, 400, { error: 'Workspace state must be an object.' });
    const updatedAt = new Date().toISOString();
    if (body.baseUpdatedAt) {
      // Only save if nobody else saved since this browser last loaded. One atomic update.
      const rows = await db('workspace_states', { workspace_id: `eq.${user.workspace_id}`, updated_at: `eq.${body.baseUpdatedAt}` }, {
        method: 'PATCH', prefer: 'return=representation', body: { state: body.state, updated_at: updatedAt }
      });
      if (!rows?.length) {
        const [latest] = await db('workspace_states', { workspace_id: `eq.${user.workspace_id}`, select: 'state,updated_at' });
        if (latest) return reply(res, 409, { error: 'A teammate saved changes first.', state: latest.state, updatedAt: latest.updated_at });
      } else {
        return reply(res, 200, { ok: true, updatedAt: rows[0].updated_at });
      }
    }
    const [saved] = await db('workspace_states', { on_conflict: 'workspace_id' }, {
      method: 'POST', prefer: 'resolution=merge-duplicates,return=representation',
      body: { workspace_id: user.workspace_id, state: body.state, updated_at: updatedAt }
    });
    return reply(res, 200, { ok: true, updatedAt: saved?.updated_at || updatedAt });
  }

  if (path === '/api/workspace/invite' && method === 'POST') {
    const user = await signedInUser(req, res);
    if (!user?.workspace_id) return reply(res, 401, { error: 'Sign in to invite a teammate.' });
    const [membership] = await db('workspace_members', { workspace_id: `eq.${user.workspace_id}`, user_id: `eq.${user.id}`, select: 'workspace_id' });
    if (!membership) return reply(res, 403, { error: 'You are not a member of this workspace.' });
    return reply(res, 201, await createInvite(user));
  }

  if (path === '/api/workspace/join' && method === 'POST') {
    const user = await signedInUser(req, res);
    if (!user) return reply(res, 401, { error: 'Sign in before joining a workspace.' });
    const { code } = await readBody(req);
    const normalizedCode = String(code || '').trim().toUpperCase();
    if (!/^[A-F0-9]{12}$/.test(normalizedCode)) return reply(res, 400, { error: 'Enter a valid 12 character invitation code.' });
    const [invite] = await db('workspace_invites', { code_hash: `eq.${digest(normalizedCode)}`, expires_at: `gt.${new Date().toISOString()}`, select: 'workspace_id' });
    if (!invite) return reply(res, 404, { error: 'That invitation code is invalid or has expired.' });
    await db('workspace_members', {}, { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: { workspace_id: invite.workspace_id, user_id: user.id, role: 'member' } });
    await db('app_users', { id: `eq.${user.id}` }, { method: 'PATCH', prefer: 'return=minimal', body: { workspace_id: invite.workspace_id } });
    return reply(res, 200, { ok: true });
  }


  if (path === '/api/predict' && method === 'POST') {
    const input = validatePredictionInput(await readBody(req));
    return reply(res, 200, { status: 'success', ...predictCashflow(input) });
  }

  if (path === '/api/risk') {
    // Signed in: customers and invoices come from the shared workspace unless the request sends them.
    // Demo (not signed in): POST with customers/invoices in the body; nothing is stored.
    const user = await memberUser(req, res).catch(() => null);
    let state = {};
    if (user) {
      const [stored] = await db('workspace_states', { workspace_id: `eq.${user.workspace_id}`, select: 'state,updated_at' });
      state = stored?.state && typeof stored.state === 'object' && !Array.isArray(stored.state) ? stored.state : {};
    }
    const today = todayIso();
    const build = (customersRaw, invoicesRaw) => withInvoiceHistory(validateRiskCustomers(Array.isArray(customersRaw) ? customersRaw : []), Array.isArray(invoicesRaw) ? invoicesRaw : [], today);
    if (method === 'GET') {
      if (!user) return reply(res, 401, { error: 'Sign in to use customer risk tools.' });
      return reply(res, 200, riskOverview(build(state.riskCustomers, state.invoices), new Date(today)));
    }
    if (method === 'PUT') {
      if (!user) return reply(res, 401, { error: 'Sign in to save customer histories.' });
      const body = await readBody(req);
      const customers = validateRiskCustomers(body.customers);
      for (let attempt = 0; attempt < 3; attempt++) { // change only riskCustomers, never a teammate's other edits
        const [latest] = await db('workspace_states', { workspace_id: `eq.${user.workspace_id}`, select: 'state,updated_at' });
        const next = { ...(latest?.state || {}), riskCustomers: customers };
        const rows = await db('workspace_states', { workspace_id: `eq.${user.workspace_id}`, updated_at: `eq.${latest?.updated_at}` }, {
          method: 'PATCH', prefer: 'return=representation', body: { state: next, updated_at: new Date().toISOString() }
        });
        if (rows?.length) return reply(res, 200, { ok: true, updatedAt: rows[0].updated_at, ...riskOverview(build(customers, next.invoices), new Date(today)) });
      }
      return reply(res, 409, { error: 'The workspace is busy. Try again.' });
    }
    if (method === 'POST') {
      const body = await readBody(req, 512_000);
      const customers = build(body.customers ?? state.riskCustomers, body.invoices ?? state.invoices);
      if (body.action === 'overview') return reply(res, 200, riskOverview(customers, new Date(today)));
      if (body.action !== 'assess') return reply(res, 400, { error: 'Choose a customer deal to assess.' });
      return reply(res, 200, assessRiskDeal(customers, body, new Date(today)));
    }
    return reply(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, POST, PUT' });
  }

  if (path === '/api/invoice/extract' && method === 'POST') {
    const user = await memberUser(req, res);
    if (!user) return reply(res, 401, { error: 'Sign in to scan invoices.' });
    const recent = (scanAttempts.get(user.id) || []).filter(time => Date.now() - time < 600_000);
    if (recent.length >= 8) return reply(res, 429, { error: 'Too many scans. Wait a few minutes and try again.' });
    scanAttempts.set(user.id, [...recent, Date.now()]);
    const body = await readBody(req, 4_400_000); // Vercel accepts request bodies up to 4.5 MB
    const mime = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(body.mime) ? body.mime : '';
    const image = typeof body.image === 'string' ? body.image : '';
    if (!mime || image.length < 200 || !/^[A-Za-z0-9+/=]+$/.test(image)) return reply(res, 400, { error: 'Upload a JPG, PNG or WebP photo, or a PDF, of the invoice.' });
    return reply(res, 200, await extractInvoice(image, mime));
  }

  if (path === '/api/reminders/list' && method === 'GET') {
    const user = await memberUser(req, res);
    if (!user) return reply(res, 401, { error: 'Sign in to see reminders.' });
    try {
      const log = await db('reminder_log', { workspace_id: `eq.${user.workspace_id}`, select: 'invoice_id,stage,status,sent_at', order: 'sent_at.desc', limit: '500' });
      return reply(res, 200, { log, ready: true });
    } catch (error) {
      return reply(res, 200, { log: [], ready: false });
    }
  }

  if (path === '/api/reminders/test' && method === 'POST') {
    const user = await memberUser(req, res);
    if (!user) return reply(res, 401, { error: 'Sign in to send a test reminder.' });
    const { invoiceId, stage: stageKey } = await readBody(req);
    const [stored] = await db('workspace_states', { workspace_id: `eq.${user.workspace_id}`, select: 'state' });
    const state = stored?.state || {}, settings = state.invSettings || {};
    const invoice = (Array.isArray(state.invoices) ? state.invoices : []).find(item => item && item.id === String(invoiceId));
    if (!invoice) return reply(res, 404, { error: 'Save the invoice first, then send a test.' });
    if (!EMAIL_PATTERN.test(String(settings.contactEmail || ''))) return reply(res, 400, { error: 'Add your contact email in Settings first. Test emails go only to you.' });
    const today = todayIso();
    const stage = STAGES.find(item => item.key === stageKey) || nextStage(invoice, today, [], { allowLegal: true }) || STAGES[0];
    const preview = ladderPreview({ invoice, settings, today }).find(item => item.stage === stage.key);
    await sendEmail({ to: settings.contactEmail, subject: '[TEST] ' + preview.subject, text: preview.text, html: preview.html, replyTo: settings.contactEmail });
    return reply(res, 200, { ok: true, sentTo: settings.contactEmail, stage: `${preview.tierLabel}, ${stage.label}` });
  }

  if (path === '/api/reminders/preview' && method === 'POST') {
    // Signed in: uses the saved invoice. Demo: uses the invoice sent in the request (nothing is stored or sent).
    const body = await readBody(req, 64_000);
    const user = await memberUser(req, res).catch(() => null);
    let invoice, settings, sentLog = [];
    if (user && body.invoiceId) {
      const [stored] = await db('workspace_states', { workspace_id: `eq.${user.workspace_id}`, select: 'state' });
      const state = stored?.state || {};
      invoice = (Array.isArray(state.invoices) ? state.invoices : []).find(item => item && item.id === String(body.invoiceId));
      settings = { ...(state.invSettings || {}), ...(body.settings && typeof body.settings === 'object' ? body.settings : {}) };
      if (invoice) sentLog = await db('reminder_log', { workspace_id: `eq.${user.workspace_id}`, invoice_id: `eq.${invoice.id}`, select: 'invoice_id,stage,status,sent_at' }).catch(() => []);
    }
    if (!invoice && body.invoice && typeof body.invoice === 'object') { invoice = body.invoice; settings = body.settings || {}; }
    if (!invoice || !(Number(invoice.amount) > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(String(invoice.dueDate || ''))) {
      return reply(res, 400, { error: 'Save the invoice with an amount and due date first.' });
    }
    invoice = { ...invoice, id: String(invoice.id || 'preview'), customer: String(invoice.customer || '').slice(0, 80), number: String(invoice.number || '').slice(0, 40) };
    const today = todayIso();
    return reply(res, 200, { ladder: ladderPreview({ invoice, settings, today, sentLog }), noticeHtml: legalNoticeHtml({ invoice, settings, today, sentLog }) });
  }

  if (path === '/api/cron/reminders' && method === 'GET') {
    const secret = process.env.CRON_SECRET;
    if (!secret || digest(String(req.headers.authorization || '')) !== digest(`Bearer ${secret}`)) return reply(res, 401, { error: 'Not allowed.' });
    const live = process.env.REMINDER_LIVE === 'true', override = process.env.REMINDER_TEST_TO || '';
    const today = todayIso();
    const workspaces = await db('workspace_states', { select: 'workspace_id,state' });
    const logs = await db('reminder_log', { select: 'workspace_id,invoice_id,stage,status,sent_at', limit: '5000' });
    const sentBy = new Map(), rowsBy = new Map();
    for (const row of logs) {
      const k = `${row.workspace_id}:${row.invoice_id}`;
      sentBy.set(k, [...(sentBy.get(k) || []), row.stage]);
      rowsBy.set(k, [...(rowsBy.get(k) || []), row]);
    }
    const planned = [], errors = [];
    let sent = 0;
    outer: for (const ws of workspaces) {
      const settings = ws.state?.invSettings || {};
      const invoices = Array.isArray(ws.state?.invoices) ? ws.state.invoices.slice(0, 500) : [];
      for (const invoice of invoices) {
        if (!validInvoiceForReminder(invoice)) continue;
        const stage = nextStage(invoice, today, sentBy.get(`${ws.workspace_id}:${invoice.id}`) || []);
        if (!stage) continue;
        const to = override || invoice.email;
        planned.push({ invoice: invoice.number || invoice.id, stage: stage.key, tier: stage.tier });
        if (!live) continue;
        if (sent >= 50) break outer;
        try {
          await db('reminder_log', {}, { method: 'POST', prefer: 'return=minimal', body: { workspace_id: ws.workspace_id, invoice_id: String(invoice.id), stage: stage.key, to_email: to, status: 'sending' } });
        } catch (error) { continue; }
        try {
          const email = buildEmail({ stage, invoice, settings, today, sentLog: rowsBy.get(`${ws.workspace_id}:${invoice.id}`) || [] });
          await sendEmail({ to, subject: (override ? '[TEST] ' : '') + email.subject, text: email.text, html: email.html, replyTo: EMAIL_PATTERN.test(String(settings.contactEmail || '')) ? settings.contactEmail : undefined });
          await db('reminder_log', { workspace_id: `eq.${ws.workspace_id}`, invoice_id: `eq.${invoice.id}`, stage: `eq.${stage.key}` }, { method: 'PATCH', prefer: 'return=minimal', body: { status: 'sent' } });
          sent++;
        } catch (error) {
          errors.push({ invoice: invoice.number || invoice.id, error: error.message });
          await db('reminder_log', { workspace_id: `eq.${ws.workspace_id}`, invoice_id: `eq.${invoice.id}`, stage: `eq.${stage.key}` }, { method: 'DELETE' }).catch(() => {});
        }
      }
    }
    return reply(res, 200, { live, today, planned, sent, errors });
  }

  return reply(res, 404, { error: 'Not found.' });
}

export function errorResponse(res, error) {
  const status = Number(error.status) >= 400 && Number(error.status) < 500 ? Number(error.status) : 500;
  if (status >= 500) console.error('ClearRun API error:', error.message, error.detail || '');
  reply(res, status, { error: status >= 500 && !error.expose ? 'The server could not complete this request. Check the backend configuration and try again.' : error.message });
}
