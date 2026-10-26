// Minimal in-memory PostgREST imitation for testing ClearRun.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
const tables = {}; const T = n => (tables[n] ||= []);
const pk = { app_users:'id', workspaces:'id', workspace_states:'workspace_id', app_sessions:'token_hash', workspace_invites:'code_hash', reminder_log:'id' };
const missing = new Set((process.env.MISSING_TABLES||'').split(',').filter(Boolean));
function match(row, q) {
  for (const [k, v] of q) {
    if (['select','order','limit','on_conflict'].includes(k)) continue;
    const [op, ...rest] = v.split('.'); const val = rest.join('.'); const cell = row[k];
    if (op==='eq' && String(cell)!==val) return false;
    if (op==='ilike') { // PostgREST: * -> %, then SQL LIKE with backslash escape, case-insensitive
      const pat=val.replace(/\*/g,'%'); let re='^';
      for (let i=0;i<pat.length;i++){const c=pat[i]; if(c==='\\'&&i+1<pat.length){re+=pat[++i].replace(/[.*+?^${}()|[\]\\]/g,'\\$&');} else if(c==='%')re+='.*'; else if(c==='_')re+='.'; else re+=c.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
      if(!new RegExp(re+'$','is').test(String(cell??''))) return false; }
    if (op==='gt' && !(String(cell) > val)) return false;
  }
  return true;
}
const pick = (r, sel) => sel && sel!=='*' ? Object.fromEntries(sel.split(',').map(c=>[c, r[c] ?? null])) : r;
createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'); const name = u.pathname.replace('/rest/v1/','');
  let body=''; for await (const c of req) body+=c; body = body?JSON.parse(body):null;
  const send=(s,d)=>{res.writeHead(s,{'Content-Type':'application/json'});res.end(d===undefined?'':JSON.stringify(d))};
  if (missing.has(name)) return send(404,{message:`relation "public.${name}" does not exist`});
  const rows=T(name), q=[...u.searchParams];
  if (req.method==='GET') { let out=rows.filter(r=>match(r,q)).map(r=>pick(r,u.searchParams.get('select'))); return send(200,out); }
  if (req.method==='POST') {
    const items = Array.isArray(body)?body:[body]; const out=[];
    for (const it of items) {
      const row={...it}; if (pk[name]==='id' && !row.id) row.id=randomUUID();
      row.created_at ||= new Date().toISOString();
      if (name==='app_users') { if (row.phone && rows.some(r=>r.phone===row.phone)) return send(409,{message:'duplicate phone'}); if (rows.some(r=>r.username.toLowerCase()===row.username.toLowerCase())) return send(409,{message:'duplicate key value violates unique constraint "app_users_username_lower_unique"'}); }
      if (name==='workspace_states') row.updated_at ||= new Date().toISOString();
      const merge=(req.headers.prefer||'').includes('merge-duplicates');
      const key = name==='workspace_members' ? r=>r.workspace_id===row.workspace_id&&r.user_id===row.user_id : r=>r[pk[name]]===row[pk[name]];
      const ex=rows.find(key);
      if (name==='reminder_log' && rows.some(r=>r.workspace_id===row.workspace_id&&r.invoice_id===row.invoice_id&&r.stage===row.stage)) return send(409,{message:'dup'});
      if (ex) { if (!merge) return send(409,{message:'duplicate key'}); Object.assign(ex,row); out.push(ex);} else { rows.push(row); out.push(row);} }
    return send(201,(req.headers.prefer||'').includes('representation')?out:undefined);
  }
  if (req.method==='PATCH') { const hit=rows.filter(r=>match(r,q)); hit.forEach(r=>Object.assign(r,body)); return send(200,(req.headers.prefer||'').includes('representation')?hit:undefined); }
  if (req.method==='DELETE') { tables[name]=rows.filter(r=>!match(r,q)); return send(204); }
}).listen(Number(process.env.MOCK_PORT||54321), ()=>console.log('mock supabase up'));
