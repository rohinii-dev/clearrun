// ClearRun v5 regression: API + browser. Usage: node regress5.cjs <baseUrl>
const {chromium}=require('playwright');
const B=process.argv[2]; let pass=0, fail=0; const out=[];
const ok=(name,cond,info='')=>{cond?pass++:fail++;out.push(`${cond?'PASS':'FAIL'}  ${name}${info!==''?'  ('+info+')':''}`)};
async function api(path,{method='GET',body,cookie,headers={}}={}){const r=await fetch(B+path,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(cookie?{cookie}:{}),...headers},body:body?JSON.stringify(body):undefined});let j={};try{j=await r.json()}catch{}return {status:r.status,json:j,cookie:(r.headers.get('set-cookie')||'').split(';')[0]}}
const iso=d=>new Date(Date.now()+d*864e5).toISOString().slice(0,10);
(async()=>{
  const t=Date.now()%1e6, P=n=>n+String(t).padStart(8,'0');
  // ---------- accounts (v4 checks) ----------
  const a=await api('/api/auth/signup',{method:'POST',body:{username:'Asha'+t,phone:P('91'),password:'password123'}}); ok('signup works',a.status===201,a.status); const ck=a.cookie;
  ok('signin by username (any case)',(await api('/api/auth/signin',{method:'POST',body:{identity:('asha'+t).toUpperCase(),password:'password123'}})).status===200);
  ok('signin by phone',(await api('/api/auth/signin',{method:'POST',body:{identity:'+91 '+String(t).padStart(8,'0'),password:'password123'}})).status===200);
  ok('wrong password rejected',(await api('/api/auth/signin',{method:'POST',body:{identity:'Asha'+t,password:'nopenopenope'}})).status===401);
  ok('duplicate username blocked',(await api('/api/auth/signup',{method:'POST',body:{username:'ASHA'+t,phone:P('92'),password:'password123'}})).status===409);
  ok('session restore',(await api('/api/session',{cookie:ck})).status===200);
  ok("signin with '*' does not match another user",(await api('/api/auth/signin',{method:'POST',body:{identity:'*',password:'password123'}})).status===401);
  const u2=await api('/api/auth/signup',{method:'POST',body:{username:'Ash_'+t,phone:P('93'),password:'password123'}}); ok("username with '_' allowed",u2.status===201);
  // ---------- health / config ----------
  const h=await api('/api/health'); ok('health reports database ok',h.status===200&&h.json.database==='ok',JSON.stringify(h.json).slice(0,120));
  ok('config gives Google client ID',/apps\.googleusercontent\.com$/.test((await api('/api/config')).json.googleClientId||''));
  ok('old /api/auth/config path still works',(await api('/api/auth/config')).status===200);
  // ---------- workspace + safe saving ----------
  const w0=await api('/api/workspace',{cookie:ck}); ok('workspace load',w0.status===200);
  const s1=await api('/api/workspace',{method:'PUT',cookie:ck,body:{state:{cashStart:5,cashProvided:true,flowItems:[],invoices:[{id:'i1',customer:'C Corp',amount:10,dueDate:iso(10),status:'open'}],invSettings:{businessName:'B'}},baseUpdatedAt:w0.json.updatedAt}});
  ok('save returns the stored timestamp',s1.status===200&&(await api('/api/workspace',{cookie:ck})).json.updatedAt===s1.json.updatedAt);
  const stale=await api('/api/workspace',{method:'PUT',cookie:ck,body:{state:{x:1},baseUpdatedAt:w0.json.updatedAt}});
  ok('stale save is refused (no silent overwrite)',stale.status===409&&stale.json.state?.invoices?.[0]?.id==='i1');
  const inv=await api('/api/workspace/invite',{method:'POST',cookie:ck}); ok('invite created',inv.status===201);
  ok('teammate joins',(await api('/api/workspace/join',{method:'POST',cookie:u2.cookie,body:{code:inv.json.code}})).status===200);
  ok('teammate sees shared invoices',(await api('/api/workspace',{cookie:u2.cookie})).json.state?.invoices?.[0]?.id==='i1');
  // ---------- reminders ladder ----------
  ok('reminders list',(await api('/api/reminders/list',{cookie:ck})).status===200);
  const pv=await api('/api/reminders/preview',{method:'POST',body:{invoice:{id:'x',customer:'Delta',amount:95000,issueDate:iso(-70),dueDate:iso(-40)},settings:{businessName:'Sri Tools',udyam:'UDYAM-KA-01-0000001',bankRate:'6.5'}}});
  ok('ladder preview works without sign-in (demo)',pv.status===200&&pv.json.ladder.length===5,pv.status);
  ok('ladder tiers gentle/formal/legal',JSON.stringify(pv.json.ladder?.map(e=>e.tier))==='["gentle","gentle","formal","formal","legal"]');
  ok('legal notice needs approval by default',pv.json.ladder?.[4]?.status==='needs approval');
  ok('printable notice generated',/NOTICE OF DEMAND/.test(pv.json.noticeHtml||''));
  ok('signed-in preview uses saved invoice',(await api('/api/reminders/preview',{method:'POST',cookie:ck,body:{invoiceId:'i1'}})).status===200);
  ok('test email explains email not set up',(await api('/api/reminders/test',{method:'POST',cookie:ck,body:{invoiceId:'i1',stage:'over_30'}})).status===400);
  // ---------- scan, cron, origin, limits ----------
  ok('invoice scan says not set up (no key)',(await api('/api/invoice/extract',{method:'POST',cookie:ck,body:{mime:'application/pdf',image:'A'.repeat(300)}})).status===424);
  ok('cron rejects without secret',(await api('/api/cron/reminders')).status===401);
  ok('cross-site origin blocked',(await api('/api/auth/signin',{method:'POST',headers:{Origin:'https://evil.example'},body:{}})).status===403);
  ok("Origin 'null' gives 403",(await api('/api/auth/signin',{method:'POST',headers:{Origin:'null'},body:{}})).status===403);
  let codes=[];for(let i=0;i<22;i++)codes.push((await api('/api/auth/signup',{method:'POST',headers:{'x-forwarded-for':'203.0.113.'+(t%200)},body:{username:'x',phone:'1',password:'1'}})).status);
  ok('signup rate limit kicks in',codes.includes(429));
  ok('poll does not re-set cookie every time',!(await api('/api/workspace',{cookie:ck})).cookie);
  // ---------- customer risk + predictor ----------
  const cust=[{id:'c1',name:'Delta Traders',type:'Trader/Retailer',years:2,terms:30,paidDelays:[12,25,18,40,33,52],overdueDays:[38],promisesKept:1,promisesBroken:4,owed:190000,overdue:95000}];
  const ro=await api('/api/risk',{method:'POST',body:{action:'overview',customers:cust,invoices:[{customer:'delta traders',amount:50000,dueDate:iso(-50),paidDate:iso(-10),status:'paid'},{customer:'New Buyer Co',amount:70000,dueDate:iso(-5),status:'open'}]}});
  ok('risk overview (demo, no sign-in)',ro.status===200&&ro.json.customers.length===2,ro.status+' '+(ro.json.error||''));
  const delta=ro.json.customers?.find(c=>c.name==='Delta Traders'); ok('invoice history merged into customer',delta?.paid_invoices===7&&delta?.from_invoices===1);
  ok('invoice-only customer appears with default profile',ro.json.customers?.some(c=>c.name==='New Buyer Co'&&c.profile_missing));
  const many=Array.from({length:6},(_,i)=>({id:'r'+i,name:'Ref '+i,type:'Trader/Retailer',years:3,terms:30,paidDelays:[10,20,30,25,15,35,28,22],overdueDays:[],promisesKept:2,promisesBroken:2,owed:0,overdue:0,avgOrder:100000}));
  const nd=await api('/api/risk',{method:'POST',body:{action:'assess',customers:many,new:{type:'Trader/Retailer',years:2,order:100000},amount:100000,terms:30}});
  ok('new-customer deal (crashed before) works',nd.status===200&&nd.json.actions?.length>0,nd.status+' '+(nd.json.decision||nd.json.error||''));
  ok('risk GET needs sign-in',(await api('/api/risk')).status===401);
  ok('risk PUT saves only customer list',(await api('/api/risk',{method:'PUT',cookie:ck,body:{customers:cust}})).status===200&&(await api('/api/workspace',{cookie:ck})).json.state?.invoices?.[0]?.id==='i1');
  const pr=await api('/api/predict',{method:'POST',body:{openingCash:100000,reserve:50000,flows:[{type:'out',amount:90000,week:1}],scenario:{delayWeeks:0,extraExpense:0,salesChange:0}}});
  ok('shortfall probability',pr.status===200&&pr.json.scenario.probabilityBelowReserve>0.5);
  // ---------- browser ----------
  const b=await chromium.launch();const ctx=await b.newContext();const p=await ctx.newPage();const errs=[];
  p.on('pageerror',e=>errs.push(e.message));p.on('console',m=>{if(m.type()==='error'&&!/TUNNEL|ERR_|status of/.test(m.text()))errs.push(m.text())});
  p.on('dialog',d=>d.accept());
  await p.goto(B);await p.waitForTimeout(600);
  await p.evaluate(()=>openAuth('signin'));
  ok('Google button slot on sign-in panel',await p.$('#googleSigninHost')!==null);
  await p.fill('#signinIdentity','Asha'+t);await p.fill('#signinPassword','password123');await p.click('#signinForm [type=submit]');
  ok('UI sign in opens dashboard',await p.waitForSelector('#dashboardView:not([hidden])',{timeout:5000}).then(()=>true).catch(()=>false));
  ok('greeting uses time of day',/^Good (morning|afternoon|evening), Asha/.test(await p.textContent('#dashGreeting')));
  ok('date range is not hard-coded',!(await p.textContent('.datepill')).includes('24 Oct to 23 Jan 2027'));
  ok('UI loads shared invoices + risk customers',await p.evaluate(()=>invoices.length===1));
  // teammate edits at the same moment
  const before=(await api('/api/workspace',{cookie:u2.cookie})).json;
  await api('/api/workspace',{method:'PUT',cookie:u2.cookie,body:{state:{...before.state,flowItems:[...(before.state.flowItems||[]),{id:'team-1',name:'Teammate receipt',type:'in',amount:1111,week:2}]},baseUpdatedAt:before.updatedAt}});
  await p.evaluate(()=>{flowItems.push({id:'me-1',name:'My payment',type:'out',amount:2222,week:3});buildFlowArrays();renderEvents();draw();saveAccountState()});
  await p.waitForTimeout(1500);
  const merged=(await api('/api/workspace',{cookie:ck})).json.state.flowItems.map(f=>f.id).sort().join(',');
  ok('simultaneous teammate edits are both kept',merged==='me-1,team-1',merged);
  ok('UI shows the teammate change too',await p.evaluate(()=>flowItems.some(f=>f.id==='team-1')));
  // invoices + scan UI with a simulated scan result
  await p.evaluate(()=>setView('invoices'));
  await p.route('**/api/invoice/extract',r=>r.fulfill({json:{fields:{number:'INV-9',customer:'Apex Auto',email:'a@apex.in',gstin:'29AAGCB7383J1Z4',amount:236000,issueDate:'2026-10-05',dueDate:'2026-11-04'},confidence:{number:'high',customer:'high',amount:'low',issueDate:'medium',dueDate:'medium'},warnings:['Total figure (200000) does not match the amount in words (236000).'],passes:2}}));
  await p.click('#invNewBtn');
  await p.setInputFiles('#invFile',{name:'inv.png',mimeType:'image/png',buffer:require('fs').readFileSync(require('path').join(__dirname,'sample.png'))});
  await p.waitForFunction(()=>document.getElementById('invAmount').value==='236000',null,{timeout:6000}).catch(()=>{});
  ok('scan fills fields incl. GSTIN',await p.evaluate(()=>document.getElementById('invGstin').value==='29AAGCB7383J1Z4'&&document.getElementById('invAmount').value==='236000'));
  ok('low-confidence fields highlighted',await p.evaluate(()=>document.getElementById('invAmount').classList.contains('check')&&!document.getElementById('invNumber').classList.contains('check')));
  ok('scan warnings listed',(await p.textContent('#invScanWarn')).includes('amount in words'));
  await p.fill('#invPaidOn',iso(-1)); await p.click('#invForm [type=submit]'); await p.waitForTimeout(400);
  ok('paid-on invoice saved as history (not expected cash)',await p.evaluate(()=>invoices[0].status==='paid'&&invoices[0].gstin==='29AAGCB7383J1Z4'&&!flowItems.some(f=>f.invoiceId===invoices[0].id)));
  await p.click('#invNewBtn'); await p.fill('#invCustomer','Bad Gst'); await p.fill('#invGstin','29AAGCB7383J1Z5'); await p.fill('#invAmount','10'); await p.fill('#invDue',iso(5)); await p.click('#invForm [type=submit]');
  ok('invalid GSTIN rejected',(await p.textContent('#invMsg')).includes('GSTIN')&&await p.evaluate(()=>!invoices.some(i=>i.customer==='Bad Gst')));
  await p.click('#invCancel');
  await p.click('[data-inv-ladder="i1"]'); await p.waitForSelector('.crdialog .tierbox',{timeout:5000}).catch(()=>{});
  ok('ladder dialog shows 3 tiers',await p.evaluate(()=>document.querySelectorAll('.crdialog .tierbox').length===3));
  await p.evaluate(()=>document.querySelector('.crdialog').close());
  // customer risk view
  await p.evaluate(()=>setView('customerRisk')); await p.waitForTimeout(800);
  ok('risk view lists customers from saved list + invoices',await p.evaluate(()=>document.querySelectorAll('#rkList .riskcustomer').length>=2));
  await p.selectOption('#rkDealCustomer','__new'); await p.fill('#rkDealAmount','120000'); await p.click('#rkDealGo'); await p.waitForTimeout(800);
  ok('deal check renders actions',await p.evaluate(()=>!document.getElementById('rkDealResult').hidden&&document.querySelectorAll('#rkDealResult li').length>0));
  ok('shortfall chance shown',await p.evaluate(()=>{setView('cashflow');return true})&&await p.waitForFunction(()=>/%|Add/.test(document.getElementById('riskNegative').textContent),null,{timeout:4000}).then(()=>true).catch(()=>false));
  await p.click('#signOut');await p.waitForTimeout(1200);
  await p.evaluate(()=>enterDemoDashboard());await p.waitForTimeout(500);
  ok('demo shows sample invoices, not the previous user',await p.evaluate(()=>invoices.every(i=>i.id.startsWith('demo-'))&&invSettings.businessName!=='B'));
  ok('demo has sample customers for risk',await p.evaluate(()=>{setView('customerRisk');return true})&&await p.waitForFunction(()=>document.querySelectorAll('#rkList .riskcustomer').length===7,null,{timeout:4000}).then(()=>true).catch(()=>false));
  await p.evaluate(()=>setView('invoices')); await p.click('[data-inv-ladder="demo-inv-2"]'); await p.waitForSelector('.crdialog .tierbox',{timeout:5000}).catch(()=>{});
  ok('demo ladder preview works',await p.evaluate(()=>document.querySelectorAll('.crdialog details.mail').length===5));
  await p.evaluate(()=>document.querySelector('.crdialog').close());
  const p2=await ctx.newPage(); p2.on('pageerror',e=>errs.push(e.message)); await p2.goto(B+'/#customerRisk'); await p2.waitForTimeout(1500);
  ok('#customerRisk link opens the risk view',await p2.evaluate(()=>!document.getElementById('dashboardView').hidden&&!document.getElementById('customerRisk').hidden));
  await p.reload();await p.waitForTimeout(500);
  await p.evaluate(()=>openAuth('signup'));await p.fill('#signupName','Ravi'+t);await p.fill('#signupPhone',P('94'));await p.fill('#signupPassword','password123');await p.click('#signupForm [type=submit]');
  ok('UI sign up opens dashboard',await p.waitForSelector('#dashboardView:not([hidden])',{timeout:5000}).then(()=>true).catch(()=>false));
  ok('new user starts empty',await p.evaluate(()=>invoices.length===0&&cashStart===0));
  await p.evaluate(()=>setView('settings'));
  ok('team panel present for signed-in user',await p.evaluate(()=>!document.getElementById('teamInvite').disabled));
  await p.click('#teamInvite'); await p.waitForTimeout(500);
  ok('invite code shown',/^[A-F0-9]{12}/.test((await p.textContent('#teamCode b').catch(()=>''))||''));
  await p.reload();ok('reload keeps user signed in',await p.waitForSelector('#dashboardView:not([hidden])',{timeout:5000}).then(()=>true).catch(()=>false));
  ok('no page errors',errs.length===0,errs.join(' | ').slice(0,300));
  await b.close();
  console.log(out.join('\n'));console.log(`\n${pass} passed, ${fail} failed`);
})().catch(e=>{console.log(out.join('\n'));console.log('CRASH',e.stack);});
