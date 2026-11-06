// Bitcoin node dashboard — Cloudflare Worker (module syntax).
//   GET  /             dashboard page
//   GET  /api/stats    latest snapshot + history (public, aggregate stats only)
//   POST /api/push     collector writes a snapshot (Bearer WRITE_KEY)
// State lives in one KV key ("state") so each push costs a single KV write.

const MAX_POINTS = 4000;
const POOL_START_BLOCK = 951552; // 29 May 2026, start of the reference pool review window

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === "string" ? v.slice(0, 64) : null);
const bool = (v) => (typeof v === "boolean" ? v : null);

function sanitizeServices(s) {
  if (!s || typeof s !== "object") return null;
  const m = num(s.miners);
  return {
    ipc: bool(s.ipc),
    tp: bool(s.tp),
    client: bool(s.client),
    miners: m === null ? null : Math.max(0, Math.min(1000, Math.floor(m))),
    tpUptime: num(s.tpUptime),
    clientUptime: num(s.clientUptime),
  };
}

function sanitizeBitaxe(b) {
  if (!b || typeof b !== "object") return null;
  if (b.online !== true) return { online: false };
  return {
    online: true,
    hashrate: num(b.hashrate), temp: num(b.temp), vrTemp: num(b.vrTemp), power: num(b.power),
    voltage: num(b.voltage), frequency: num(b.frequency), fanRpm: num(b.fanRpm), fanPct: num(b.fanPct),
    accepted: num(b.accepted), rejected: num(b.rejected), bestDiff: str(b.bestDiff),
    uptime: num(b.uptime), rssi: num(b.rssi),
  };
}

function numMap(o, max) {
  const out = {};
  if (!o || typeof o !== "object") return out;
  for (const [k, v] of Object.entries(o)) {
    if (Object.keys(out).length >= max) break;
    if (/^[A-Za-z0-9_]{1,40}$/.test(k) && num(v) !== null) out[k] = v;
  }
  return out;
}

function sanitizeDmnd(d) {
  if (!d || typeof d !== "object") return null;
  const t = Array.isArray(d.templates) ? d.templates.slice(0, 3) : [];
  return {
    templates: t.filter((x) => x && typeof x === "object").map((x) => ({
      height: num(x.height), fees: num(x.fees), txCount: num(x.txCount), fullness: num(x.fullness),
      feeRate: num(x.feeRate), prioritized: num(x.prioritized), declared: bool(x.declared),
      gained: num(x.gained), coinbase: num(x.coinbase), age: num(x.age),
    })),
    stats: numMap(d.stats, 16),
    pool: numMap(d.pool, 8),
  };
}

function sanitizeRes(r) {
  if (!r || typeof r !== "object") return null;
  return { memBytes: num(r.memBytes), cpuPct: num(r.cpuPct), diskFree: num(r.diskFree), diskTotal: num(r.diskTotal) };
}

function sanitize(body) {
  const n = body.network && typeof body.network === "object" ? body.network : {};
  const nets = {};
  for (const [k, v] of Object.entries(n)) {
    if (/^[a-z0-9_]{1,16}$/.test(k) && num(v) !== null) nets[k] = v;
  }
  return {
    t: Math.floor(Date.now() / 1000),
    chain: str(body.chain),
    blocks: num(body.blocks),
    headers: num(body.headers),
    progress: num(body.progress),
    ibd: bool(body.ibd),
    tipTime: num(body.tipTime),
    difficulty: num(body.difficulty),
    sizeOnDisk: num(body.sizeOnDisk),
    pruned: bool(body.pruned),
    pruneHeight: num(body.pruneHeight),
    pruneTarget: num(body.pruneTarget),
    peersIn: num(body.peersIn),
    peersOut: num(body.peersOut),
    networks: nets,
    mempoolTx: num(body.mempoolTx),
    mempoolBytes: num(body.mempoolBytes),
    version: str(body.version),
    uptime: num(body.uptime),
    services: sanitizeServices(body.services),
    netDifficulty: num(body.netDifficulty),
    bytesIn: num(body.bytesIn),
    bytesOut: num(body.bytesOut),
    resources: sanitizeRes(body.resources),
    bitaxe: sanitizeBitaxe(body.bitaxe),
    dmnd: sanitizeDmnd(body.dmnd),
  };
}

function thin(arr) {
  // Keep the newest quarter intact, drop every other older point.
  const keepFrom = Math.floor(arr.length * 0.75);
  return arr.filter((_, i) => i >= keepFrom || i % 2 === 0);
}

async function handlePush(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const expected = "Bearer " + env.WRITE_KEY;
  if (!env.WRITE_KEY || auth.length !== expected.length) return new Response("unauthorized", { status: 401 });
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= auth.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return new Response("unauthorized", { status: 401 });

  const raw = await request.text();
  if (raw.length > 20000) return new Response("too large", { status: 413 });
  let body;
  try { body = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }
  const snap = sanitize(body);

  const state = (await env.KV.get("state", "json")) || { latest: null, history: [] };
  state.latest = snap;
  state.history.push({
    t: snap.t, blocks: snap.blocks, headers: snap.headers, progress: snap.progress,
    peers: (snap.peersIn || 0) + (snap.peersOut || 0), mempool: snap.mempoolTx, disk: snap.sizeOnDisk,
    hr: snap.bitaxe && snap.bitaxe.online ? snap.bitaxe.hashrate : null,
    temp: snap.bitaxe && snap.bitaxe.online ? snap.bitaxe.temp : null,
  });
  if (state.history.length > MAX_POINTS) state.history = thin(state.history);
  await env.KV.put("state", JSON.stringify(state));
  return new Response("ok");
}

async function handleStats(env) {
  const state = (await env.KV.get("state", "json")) || { latest: null, history: [] };
  return new Response(JSON.stringify({ ...state, now: Math.floor(Date.now() / 1000), poolStart: POOL_START_BLOCK }), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=15" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/push" && request.method === "POST") return handlePush(request, env);
    if (url.pathname === "/api/stats" && request.method === "GET") return handleStats(env);
    if (url.pathname === "/" && request.method === "GET") {
      return new Response(PAGE, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "public, max-age=60",
          "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        },
      });
    }
    return new Response("not found", { status: 404 });
  },
};

const PAGE = String.raw`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bitcoin Node</title>
<style>
:root{--bg:#f6f5f1;--card:#fff;--ink:#1b1b18;--mute:#6b6a63;--line:#e4e2da;--accent:#e8820c;--ok:#1f8f4e;--bad:#c0392b;--bar:#ece9df}
@media (prefers-color-scheme:dark){:root{--bg:#141412;--card:#1d1d1a;--ink:#ecebe5;--mute:#9a988f;--line:#2e2d29;--accent:#f5a03a;--ok:#4cc27f;--bad:#ef6b5b;--bar:#2a2926}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:980px;margin:0 auto;padding:24px 16px 48px}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;margin-bottom:18px}
h1{font-size:22px;margin:0;letter-spacing:-.01em}
.pill{display:inline-block;padding:3px 10px;border-radius:99px;font-size:13px;font-weight:600;border:1px solid var(--line);background:var(--card)}
.pill.sync{color:var(--accent)}.pill.ok{color:var(--ok)}.pill.bad{color:var(--bad)}
.sub{color:var(--mute);font-size:13px}
nav{display:flex;gap:6px;margin:0 0 16px}
nav button{font:inherit;padding:6px 14px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--mute);cursor:pointer}
nav button[aria-selected=true]{color:var(--ink);border-color:var(--accent)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
.prog .row{display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap}
.big{font-size:34px;font-weight:700;letter-spacing:-.02em}
.bar{height:12px;border-radius:99px;background:var(--bar);overflow:hidden;margin:10px 0 8px}
.bar>i{display:block;height:100%;background:var(--accent);border-radius:99px;width:0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:12px;margin:12px 0}
.stat .k,.tpl .k{color:var(--mute);font-size:12px;text-transform:uppercase;letter-spacing:.05em}
.stat .v,.tpl .v{font-size:22px;font-weight:650;margin-top:2px;word-break:break-word}
.stat .s,.tpl .s{color:var(--mute);font-size:12px;margin-top:2px}

.stat.dim{opacity:.55}
.tpl.decl{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
h2.sec{font-size:13px;margin:18px 0 0;color:var(--mute);text-transform:uppercase;letter-spacing:.05em}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:7px;background:var(--mute);vertical-align:middle}
.dot.on{background:var(--ok)}.dot.off{background:var(--bar);box-shadow:inset 0 0 0 1px var(--mute)}
.story{margin:12px 0;padding:14px 16px;border-left:4px solid var(--accent);line-height:1.55}
.story.ok{border-left-color:var(--ok)}.story.bad{border-left-color:var(--bad)}
.flowl{font-size:12px;color:var(--mute);text-transform:uppercase;letter-spacing:.05em;margin:16px 0 6px}
.flow{display:flex;flex-wrap:wrap;align-items:stretch;gap:6px}
.fn{flex:1 1 150px;min-width:140px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.fn .t{font-weight:650;font-size:14px}.fn .m{font-size:20px;font-weight:650;margin-top:4px;word-break:break-word}
.fn .s{font-size:12px;color:var(--mute);margin-top:2px}.fn.ext{border-style:dashed}
.fa{display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--mute);font-size:11px;min-width:50px;text-align:center}
.fa b{font-size:22px;line-height:1}.fa.live b{color:var(--ok)}.fa.dead b{color:var(--bad)}
.note{color:var(--mute);font-size:12px;margin:6px 2px 0}
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}
.chart h2{font-size:14px;margin:0 0 8px}
svg{width:100%;height:auto;display:block}
.ax{fill:var(--mute);font-size:10px}
.empty{color:var(--mute);padding:24px 0;text-align:center}
footer{margin-top:24px;color:var(--mute);font-size:12px}
[hidden]{display:none!important}
</style></head><body><div class="wrap">
<header>
  <div><h1>Bitcoin node</h1><div class="sub" id="meta">loading…</div></div>
  <span class="pill" id="status">…</span>
</header>
<nav role="tablist">
  <button role="tab" id="t-status" aria-selected="true">Status</button>
  <button role="tab" id="t-pools" aria-selected="false">Pools</button>
</nav>

<section id="p-status">
  <div class="card prog">
    <div class="row"><span class="big" id="pct">–</span><span class="sub" id="pdetail"></span></div>
    <div class="bar"><i id="barfill"></i></div>
    <div class="sub" id="pmore"></div>
  </div>
  <div class="grid" id="stats"></div>
  <h2 class="sec">Mining stack</h2>
  <div class="card story" id="story">loading&hellip;</div>
  <div class="flowl">Hash flow &middot; work your miner does</div>
  <div class="flow" id="flowA"></div>
  <div class="flowl">Template flow &middot; the block your own node builds</div>
  <div class="flow" id="flowB"></div>
  <h2 class="sec" id="oddsh" hidden>Block odds</h2>
  <div class="grid" id="odds"></div>
  <div class="note" id="oddsnote" hidden></div>
  <h2 class="sec">Block templates</h2>
  <div class="note" id="tpnote"></div>
  <div class="grid" id="tpl"></div>
  <h2 class="sec" id="cph" hidden>DMND client</h2>
  <div class="grid" id="cpg"></div>
  <h2 class="sec" id="bxh" hidden>Bitaxe</h2>
  <div class="grid" id="bx"></div>
  <div class="charts">
    <div class="card chart"><h2>Blocks validated</h2><div id="c1"></div></div>
    <div class="card chart"><h2>Sync speed (blocks/min)</h2><div id="c2"></div></div>
    <div class="card chart"><h2>Connected peers</h2><div id="c3"></div></div>
    <div class="card chart"><h2>Disk used (GB)</h2><div id="c4"></div></div>
    <div class="card chart"><h2>Bitaxe hashrate (GH/s)</h2><div id="c5"></div></div>
    <div class="card chart"><h2>Bitaxe temperature (&deg;C)</h2><div id="c6"></div></div>
  </div>
</section>

<section id="p-pools" hidden>
  <div class="card">
    <div class="big" id="poolpct">–</div>
    <div class="bar"><i id="poolbar"></i></div>
    <div class="sub" id="pooltxt"></div>
  </div>
  <div class="card empty" style="margin-top:12px">
    Pool hashrate shares are computed from the coinbase of recent blocks, so this tab fills in once the node
    has validated blocks from the start of the review window up to the chain tip. Nothing to show yet.
  </div>
</section>

<footer>Aggregate node statistics only. No peer addresses or machine details are published. Updates about every 2 minutes.</footer>
</div>
<script>
(function(){
var $=function(id){return document.getElementById(id)};
function fmt(n){return n==null?'–':Number(n).toLocaleString('en-US')}
function gb(b){return b==null?'–':(b/1e9).toFixed(1)+' GB'}
function ago(s){if(s<90)return s+'s ago';if(s<5400)return Math.round(s/60)+' min ago';if(s<172800)return Math.round(s/3600)+' h ago';return Math.round(s/86400)+' d ago'}
function dur(s){var d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return d?d+'d '+h+'h':h?h+'h '+m+'m':m+'m'}
function dstr(t){return t?new Date(t*1000).toISOString().slice(0,10):'–'}
function hb(b){if(b==null)return '–';var u=['B','KB','MB','GB','TB'],i=0;while(b>=1024&&i<4){b/=1024;i++}return b.toFixed(i>1?1:0)+' '+u[i]}
function nets(o){if(!o)return '–';var k=Object.keys(o);if(!k.length)return '–';return k.map(function(n){return n+' '+o[n]}).join(' · ')}
function hrate(g){return g==null?'–':g>=1000?(g/1000).toFixed(2)+' TH/s':g.toFixed(0)+' GH/s'}
function fnode(title,state,main,sub,ext){var d=document.createElement('div');d.className='fn'+(ext?' ext':'');
  var t=document.createElement('div');t.className='t';
  var dot=document.createElement('span');dot.className='dot '+(state===true?'on':state===false?'off':'');
  t.appendChild(dot);t.appendChild(document.createTextNode(title));d.appendChild(t);
  var m=document.createElement('div');m.className='m';m.textContent=main;d.appendChild(m);
  if(sub){var s=document.createElement('div');s.className='s';s.textContent=sub;d.appendChild(s)}
  return d}
function farrow(label,st){var d=document.createElement('div');d.className='fa '+(st||'');
  var b=document.createElement('b');b.textContent='→';d.appendChild(b);
  var s=document.createElement('span');s.textContent=label;d.appendChild(s);return d}
function hnum(n,dp){if(n==null||!isFinite(n))return '–';dp=dp==null?2:dp;var u=[[1e21,'Z'],[1e18,'E'],[1e15,'P'],[1e12,'T'],[1e9,'G'],[1e6,'M'],[1e3,'K']];for(var i=0;i<u.length;i++){if(n>=u[i][0])return (n/u[i][0]).toFixed(dp)+' '+u[i][1]}return n.toFixed(0)}
function parseDiff(s){if(s==null)return null;var m=/^([0-9.]+)\s*([KMGTPE]?)$/i.exec(String(s).trim());if(!m)return null;var f={'':1,K:1e3,M:1e6,G:1e9,T:1e12,P:1e15,E:1e18}[m[2].toUpperCase()];return parseFloat(m[1])*f}
function years(sec){var y=sec/31557600;if(y>=1e9)return (y/1e9).toFixed(1)+' billion years';if(y>=1e6)return (y/1e6).toFixed(1)+' million years';if(y>=1e3)return Math.round(y).toLocaleString('en-US')+' years';if(y>=1)return y.toFixed(1)+' years';return Math.max(1,Math.round(sec/86400))+' days'}
function renderStack(l,s,synced,pct){
  var sv=l.services,bx=l.bitaxe,A=$('flowA'),B=$('flowB'),st=$('story');A.textContent='';B.textContent='';
  if(!sv){st.textContent='No mining stack data reported yet.';return}
  var hashing=!!(bx&&bx.online&&bx.hashrate>0),msg,cls='';
  if(!sv.ipc){msg='The node is not running in multiprocess mode, so sv2-tp cannot attach to it.';cls='bad'}
  else if(!sv.tp){msg='sv2-tp is not running, so the DMND client has no block templates from your node.';cls='bad'}
  else if(!synced){msg='The node is still syncing ('+(pct==null?'0':pct.toFixed(1))+'%). sv2-tp is running but cannot build block templates until the node reaches the chain tip, so the DMND client has nothing to declare to the pool and the Bitaxe stays idle. Mining starts by itself once the sync finishes.'}
  else if(!sv.client){msg='The node is synced and sv2-tp is serving templates, but the DMND client is not running.';cls='bad'}
  else if(!sv.miners){msg='The whole stack is ready. Waiting for a miner to connect to the DMND client.'}
  else if(hashing){msg='Mining: the Bitaxe is hashing at '+hrate(bx.hashrate)+' on block templates built by your own node and declared to the pool through the DMND client.';cls='ok'}
  else{msg='A miner is connected. Waiting for the first work and shares.'}
  st.textContent=msg;st.className='card story '+cls;
  var cl=fnode('DMND client',sv.client,sv.client?'Up':'Down',sv.client?(sv.clientUptime!=null?'running '+dur(sv.clientUptime)+' · ':'')+fmt(sv.miners)+' miner'+(sv.miners===1?'':'s'):'not running');
  A.appendChild(fnode('Bitaxe',bx?bx.online:null,bx?(bx.online?hrate(bx.hashrate):'Offline'):'not monitored',bx&&bx.online&&bx.accepted!=null?fmt(bx.accepted)+' shares accepted':''));
  A.appendChild(farrow('Stratum V1',sv.client?(sv.miners?'live':''):'dead'));
  A.appendChild(cl);
  A.appendChild(farrow('Stratum V2',''));
  A.appendChild(fnode('DMND pool',null,'external','not monitored from here',true));
  B.appendChild(fnode('Bitcoin node',true,synced?'Synced':(pct==null?'0':pct.toFixed(1))+'%',fmt(l.blocks)+' of '+fmt(l.headers)+' blocks'));
  B.appendChild(farrow('IPC',sv.ipc?'live':'dead'));
  B.appendChild(fnode('sv2-tp',sv.tp,sv.tp?(synced?'Serving templates':'Waiting for sync'):'Down',sv.tpUptime!=null?'running '+dur(sv.tpUptime):''));
  B.appendChild(farrow('Templates',sv.tp?(synced?'live':''):'dead'));
  B.appendChild(fnode('Job declaration',null,sv.tp&&sv.client&&synced?'Ready':'Waiting',sv.tp&&sv.client&&synced?'your templates go to the pool':'needs a synced node',true));
}
function renderOdds(l,s){
  var g=$('odds'),hd=$('oddsh'),nt=$('oddsnote');g.textContent='';
  var bx=l.bitaxe,nd=l.netDifficulty;
  hd.hidden=!bx||!nd;nt.hidden=hd.hidden;if(hd.hidden)return;
  var hr=bx.online&&bx.hashrate>0?bx.hashrate:0;
  if(!hr){for(var i=s.history.length-1;i>=0;i--){var v=s.history[i].hr;if(v>0){hr=v;break}}}
  var netH=nd*4294967296/600,assumed=false;
  g.appendChild(stat('Network hashrate',hnum(netH)+'H/s','from difficulty '+hnum(nd)));
  if(!hr){hr=1200;assumed=true}
  var mine=hr*1e9,share=mine/netH,reward=50/Math.pow(2,Math.floor((l.headers||0)/210000));
  var secs=nd*4294967296/mine,sats=share*144*reward*1e8,best=parseDiff(bx.bestDiff);
  [['Your hashrate',hrate(hr),assumed?'assumed, typical Gamma':'Bitaxe'],
   ['Your share','1 in '+hnum(1/share,1),'of all network hashrate'],
   ['Time to a block',years(secs),'expected, on average'],
   ['Expected per day',(sats<10?sats.toFixed(1):Math.round(sats))+' sats','if mining solo, before pool fees'],
   ['Best share',bx.bestDiff||'–',best&&nd?'1 in '+hnum(nd/best,1)+' of a block':'']
  ].forEach(function(r){g.appendChild(stat(r[0],r[1],r[2]))});
  nt.textContent=(assumed?'The Bitaxe is not hashing yet, so these use an assumed 1.2 TH/s. ':'')+'Estimates use the best known network difficulty and a block reward of '+reward+' BTC, ignoring fees. A pool pays by shares, so real earnings are smoother than this.';
}
function stat(k,v,s){var d=document.createElement('div');d.className='card stat';
  var a=document.createElement('div');a.className='k';a.textContent=k;
  var b=document.createElement('div');b.className='v';b.textContent=v;
  d.appendChild(a);d.appendChild(b);
  if(s){var c=document.createElement('div');c.className='s';c.textContent=s;d.appendChild(c)}
  return d}
function human(k){return k.replace(/([a-z])([A-Z])/g,'$1 $2').replace(/_/g,' ').replace(/^./,function(c){return c.toUpperCase()})}
function sats(n){return n==null?'–':fmt(Math.round(n))+' sats'}
function renderTemplates(l,synced){
  var g=$('tpl'),nt=$('tpnote'),d=l.dmnd,t=d&&d.templates||[];g.textContent='';
  if(!t.length){
    nt.textContent=synced?'Waiting for the DMND client to report block templates.':'Once the node finishes syncing, sv2-tp builds candidate blocks from the mempool and the DMND client lists the latest three here: total fees, how full the block is, fee rate and transaction count. The one marked Declared is the block your miner works on. Only totals are shown, never individual transactions.';
    ['Total fees','Block fullness','Fee rate','Transactions'].forEach(function(k){var c=stat(k,'–','after sync');c.className+=' dim';g.appendChild(c)});
    return}
  nt.textContent='The latest candidate blocks your node built, newest first. Declared is the block your miner is hashing on. Totals only, no transactions are published.';
  t.forEach(function(x,i){
    var c=document.createElement('div');c.className='card tpl'+(x.declared?' decl':'');
    var h=document.createElement('div');h.className='k';h.textContent=(x.declared?'Declared · ':'Candidate · ')+(x.height!=null?'block '+fmt(x.height):'template '+(i+1));c.appendChild(h);
    var v=document.createElement('div');v.className='v';v.textContent=sats(x.fees);c.appendChild(v);
    var rows=[['Fullness',x.fullness==null?'–':x.fullness.toFixed(1)+'%'],['Fee rate',x.feeRate==null?'–':x.feeRate.toFixed(1)+' sat/vB'],['Transactions',fmt(x.txCount)],['Prioritised',fmt(x.prioritized)],['Fees gained',x.gained==null?'–':(x.gained>=0?'+':'')+fmt(Math.round(x.gained))+' sats']];
    rows.forEach(function(r){var p=document.createElement('div');p.className='s';p.textContent=r[0]+': '+r[1];c.appendChild(p)});
    var bar=document.createElement('div');bar.className='bar';var f=document.createElement('i');f.style.width=Math.max(0,Math.min(100,x.fullness||0))+'%';bar.appendChild(f);c.appendChild(bar);
    g.appendChild(c)})
}
function renderClient(l){
  var g=$('cpg'),d=l.dmnd,hd=$('cph');g.textContent='';
  var all=[];if(d){Object.keys(d.stats||{}).forEach(function(k){all.push([k,d.stats[k]])});Object.keys(d.pool||{}).forEach(function(k){all.push([k,d.pool[k]])})}
  hd.hidden=!all.length;
  all.forEach(function(r){g.appendChild(stat(human(r[0]),r[1]>=1e6?hnum(r[1]):fmt(Math.round(r[1]*100)/100),''))})
}
function chart(el,pts,opt){
  el.textContent='';
  if(!pts||pts.length<2){var e=document.createElement('div');e.className='empty';e.textContent='collecting data…';el.appendChild(e);return}
  var W=600,H=170,L=46,R=8,T=8,B=22;
  var x0=pts[0][0],x1=pts[pts.length-1][0],lo=Infinity,hi=-Infinity;
  pts.forEach(function(p){if(p[1]<lo)lo=p[1];if(p[1]>hi)hi=p[1]});
  if(opt.zero)lo=Math.min(lo,0);
  if(hi===lo){hi=lo+1}
  var sx=function(t){return L+(t-x0)/Math.max(1,x1-x0)*(W-L-R)};
  var sy=function(v){return T+(1-(v-lo)/(hi-lo))*(H-T-B)};
  var d=pts.map(function(p,i){return(i?'L':'M')+sx(p[0]).toFixed(1)+' '+sy(p[1]).toFixed(1)}).join('');
  var ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');
  svg.setAttribute('viewBox','0 0 '+W+' '+H);
  function add(tag,attrs,txt){var n=document.createElementNS(ns,tag);for(var k in attrs)n.setAttribute(k,attrs[k]);if(txt!=null)n.textContent=txt;svg.appendChild(n);return n}
  [0,.5,1].forEach(function(f){var y=T+f*(H-T-B);add('line',{x1:L,x2:W-R,y1:y,y2:y,stroke:'var(--line)'});
    add('text',{x:L-6,y:y+3,'text-anchor':'end','class':'ax'},opt.fmt(hi-(hi-lo)*f))});
  add('path',{d:d+'L'+sx(x1).toFixed(1)+' '+(H-B)+'L'+sx(x0).toFixed(1)+' '+(H-B)+'Z',fill:'var(--accent)',opacity:'.12'});
  add('path',{d:d,fill:'none',stroke:'var(--accent)','stroke-width':'2','stroke-linejoin':'round'});
  var tl=function(t){var dt=new Date(t*1000);return (x1-x0>172800)?dt.toISOString().slice(5,10):dt.toISOString().slice(11,16)+'Z'};
  add('text',{x:L,y:H-6,'class':'ax'},tl(x0));
  add('text',{x:W-R,y:H-6,'text-anchor':'end','class':'ax'},tl(x1));
  el.appendChild(svg)}
function speed(h){
  var out=[],i,j;
  for(i=1;i<h.length;i++){
    j=i;while(j>0&&h[i].t-h[j-1].t<=600)j--;
    var dt=h[i].t-h[j].t;if(dt<120||h[i].blocks==null||h[j].blocks==null)continue;
    out.push([h[i].t,(h[i].blocks-h[j].blocks)/dt*60])}
  return out}
function render(s){
  var l=s.latest;
  if(!l){$('meta').textContent='no data yet — waiting for the first report from the node';$('status').textContent='waiting';return}
  var age=s.now-l.t,stale=age>600,synced=l.ibd===false&&l.blocks>=l.headers-2;
  var st=$('status');st.className='pill '+(stale?'bad':synced?'ok':'sync');
  st.textContent=stale?'node offline?':synced?'Synced':'Syncing';
  $('meta').textContent=(l.chain||'')+' · '+(l.version||'')+' · updated '+ago(age);
  var pct=l.progress==null?null:l.progress*100;
  $('pct').textContent=pct==null?'–':(pct<99.99?pct.toFixed(2):'100')+'%';
  $('barfill').style.width=(pct||0)+'%';
  $('pdetail').textContent='block '+fmt(l.blocks)+' of '+fmt(l.headers);
  var left=(l.headers||0)-(l.blocks||0);
  $('pmore').textContent=synced?'Fully synced to the chain tip.':'Validated up to '+dstr(l.tipTime)+' · '+fmt(left)+' blocks to go. Percent is weighted by transactions, so it moves slowly at first.';
  var sp=speed(s.history),last=sp.length?sp[sp.length-1][1]:null;
  var g=$('stats');g.textContent='';
  [['Block height',fmt(l.blocks),l.headers!=null?fmt(left)+' behind headers':''],
   ['Sync speed',last==null?'–':last.toFixed(last<10?1:0)+' /min','recent average'],
   ['Peers',fmt((l.peersIn||0)+(l.peersOut||0)),fmt(l.peersOut)+' out · '+fmt(l.peersIn)+' in'],
   ['Mempool',fmt(l.mempoolTx)+' tx',l.mempoolBytes!=null?(l.mempoolBytes/1e6).toFixed(1)+' MB':''],
   ['Disk used',gb(l.sizeOnDisk),l.pruned?'pruned · target '+gb(l.pruneTarget):'full archive'],
   ['Oldest block kept',l.pruned?fmt(l.pruneHeight):'all',l.pruned?'older blocks pruned':''],
   ['Difficulty',l.difficulty==null?'–':l.difficulty>=1e12?(l.difficulty/1e12).toFixed(2)+' T':(l.difficulty/1e9).toFixed(2)+' G','at block '+fmt(l.blocks)],
   ['Uptime',l.uptime==null?'–':dur(l.uptime),''],
   ['Latest block',synced&&l.tipTime?ago(s.now-l.tipTime):dstr(l.tipTime),synced?'time since last block':'date being validated'],
   ['Data transferred',l.bytesIn==null?'–':hb(l.bytesIn+l.bytesOut),l.bytesIn==null?'':hb(l.bytesIn)+' in · '+hb(l.bytesOut)+' out'],
   ['Peers by network',nets(l.networks),'connected now'],
   ['Node memory',l.resources&&l.resources.memBytes!=null?hb(l.resources.memBytes):'–',l.resources&&l.resources.cpuPct!=null?l.resources.cpuPct.toFixed(0)+'% CPU':''],
   ['Disk free',l.resources&&l.resources.diskFree!=null?hb(l.resources.diskFree):'–',l.resources&&l.resources.diskTotal!=null?'of '+hb(l.resources.diskTotal):'']
  ].forEach(function(r){g.appendChild(stat(r[0],r[1],r[2]))});
  renderStack(l,s,synced,pct);renderOdds(l,s);renderTemplates(l,synced);renderClient(l);
  var bx=l.bitaxe,bg=$('bx');bg.textContent='';$('bxh').hidden=!bx;
  if(bx&&!bx.online){bg.appendChild(stat('Bitaxe','Offline','not answering on the network'))}
  else if(bx){
    var eff=bx.power!=null&&bx.hashrate?(bx.power/(bx.hashrate/1000)).toFixed(1)+' J/TH':'';
    [['Hashrate',hrate(bx.hashrate),bx.frequency!=null?bx.frequency+' MHz':''],
     ['ASIC temperature',bx.temp==null?'–':bx.temp<=0?'idle':bx.temp.toFixed(1)+' °C',bx.vrTemp!=null?'regulator '+bx.vrTemp.toFixed(1)+' °C':''],
     ['Power',bx.power==null?'–':bx.power.toFixed(1)+' W',eff],
     ['Shares',fmt(bx.accepted)+' / '+fmt(bx.rejected),bx.bestDiff?'accepted / rejected · best '+bx.bestDiff:'accepted / rejected'],
     ['Fan',bx.fanRpm==null?'–':fmt(bx.fanRpm)+' rpm',bx.fanPct!=null?bx.fanPct+'%':''],
     ['Input voltage',bx.voltage==null?'–':(bx.voltage/1000).toFixed(2)+' V','power supply'],
     ['Bitaxe uptime',bx.uptime==null?'–':dur(bx.uptime),bx.rssi!=null?'Wi-Fi '+bx.rssi+' dBm':'']
    ].forEach(function(r){bg.appendChild(stat(r[0],r[1],r[2]))});
  }
  var h=s.history;
  chart($('c5'),h.filter(function(p){return p.hr!=null}).map(function(p){return[p.t,p.hr]}),{fmt:function(v){return v.toFixed(0)},zero:true});
  chart($('c6'),h.filter(function(p){return p.temp!=null&&p.temp>0}).map(function(p){return[p.t,p.temp]}),{fmt:function(v){return v.toFixed(0)}});
  chart($('c1'),h.filter(function(p){return p.blocks!=null}).map(function(p){return[p.t,p.blocks]}),{fmt:function(v){return fmt(Math.round(v))}});
  chart($('c2'),sp,{fmt:function(v){return v.toFixed(0)},zero:true});
  chart($('c3'),h.filter(function(p){return p.peers!=null}).map(function(p){return[p.t,p.peers]}),{fmt:function(v){return v.toFixed(0)},zero:true});
  chart($('c4'),h.filter(function(p){return p.disk!=null}).map(function(p){return[p.t,p.disk/1e9]}),{fmt:function(v){return v.toFixed(1)}});
  var ps=s.poolStart,pp=Math.max(0,Math.min(100,((l.blocks||0)/ps)*100));
  if(l.blocks>=ps){$('poolpct').textContent='Window reached';$('poolbar').style.width='100%';$('pooltxt').textContent='Block data from '+fmt(ps)+' onward is on the node. Pool analysis is not wired up yet.'}
  else{$('poolpct').textContent=pp.toFixed(1)+'% to window start';$('poolbar').style.width=pp+'%';$('pooltxt').textContent='The review window begins at block '+fmt(ps)+' (29 May 2026). Node is at block '+fmt(l.blocks)+'.'}
}
function load(){fetch('/api/stats').then(function(r){return r.json()}).then(render).catch(function(){$('meta').textContent='could not load stats'})}
function tab(n){['status','pools'].forEach(function(k){$('p-'+k).hidden=k!==n;$('t-'+k).setAttribute('aria-selected',k===n)})}
$('t-status').onclick=function(){tab('status')};$('t-pools').onclick=function(){tab('pools')};
load();setInterval(load,30000);
})();
</script></body></html>`;
