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
.stat .k{color:var(--mute);font-size:12px;text-transform:uppercase;letter-spacing:.05em}
.stat .v{font-size:22px;font-weight:650;margin-top:2px;word-break:break-word}
.stat .s{color:var(--mute);font-size:12px;margin-top:2px}
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
  <div class="charts">
    <div class="card chart"><h2>Blocks validated</h2><div id="c1"></div></div>
    <div class="card chart"><h2>Sync speed (blocks/min)</h2><div id="c2"></div></div>
    <div class="card chart"><h2>Connected peers</h2><div id="c3"></div></div>
    <div class="card chart"><h2>Disk used (GB)</h2><div id="c4"></div></div>
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
function stat(k,v,s){var d=document.createElement('div');d.className='card stat';
  var a=document.createElement('div');a.className='k';a.textContent=k;
  var b=document.createElement('div');b.className='v';b.textContent=v;
  d.appendChild(a);d.appendChild(b);
  if(s){var c=document.createElement('div');c.className='s';c.textContent=s;d.appendChild(c)}
  return d}
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
   ['Uptime',l.uptime==null?'–':dur(l.uptime),'']
  ].forEach(function(r){g.appendChild(stat(r[0],r[1],r[2]))});
  var h=s.history;
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
