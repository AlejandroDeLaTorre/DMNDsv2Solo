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
      gained: num(x.gained), coinbase: num(x.coinbase), age: num(x.age), accel: num(x.accel),
    })),
    stats: numMap(d.stats, 16),
    pool: numMap(d.pool, 8),
    activeId: num(d.activeId),
    tag: typeof d.tag === "string" && /^[A-Za-z0-9 _.\/-]{1,48}$/.test(d.tag) ? d.tag : null,
    policy: typeof d.policy === "string" && /^[a-z_]{1,32}$/.test(d.policy) ? d.policy : null,
    prio: d.prio && typeof d.prio === "object"
      ? { enabled: bool(d.prio.enabled), mempoolSpace: num(d.prio.mempoolSpace), manual: num(d.prio.manual) } : null,
  };
}

function sanitizeFinal(f) {
  if (!Array.isArray(f)) return [];
  return f.slice(-12).filter((x) => x && typeof x === "object" && num(x.height) !== null && num(x.fees) !== null)
    .map((x) => ({ height: num(x.height), fees: num(x.fees), txCount: num(x.txCount), fullness: num(x.fullness), age: num(x.age) }));
}

function declaredFees(d) {
  if (!d || !d.templates) return null;
  const x = d.templates.find((t) => t.declared === true);
  return x ? x.fees : null;
}

function sanitizeFees(f) {
  if (!f || typeof f !== "object") return null;
  const b = Array.isArray(f.buckets) ? f.buckets.slice(0, 7).map(num) : null;
  return { buckets: b && b.every((x) => x !== null) ? b : null, estimates: numMap(f.estimates, 6) };
}

function sanitizeRecent(r) {
  if (!Array.isArray(r)) return [];
  return r.slice(0, 6).filter((x) => x && typeof x === "object").map((x) => ({
    height: num(x.height), time: num(x.time), txs: num(x.txs), size: num(x.size), weight: num(x.weight),
    fees: num(x.fees), feeRate: num(x.feeRate), subsidy: num(x.subsidy), pool: str(x.pool),
  }));
}

function parseDiff(s) {
  const m = /^([0-9.]+)\s*([KMGTPE]?)$/i.exec(String(s || "").trim());
  if (!m) return null;
  const f = { "": 1, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 }[m[2].toUpperCase()];
  return parseFloat(m[1]) * f;
}

const KINDS = ["opreturn", "inscription", "baremultisig", "dust", "truc", "anchor", "big", "nonstandardout"];

function sanitizeKinds(o) {
  if (!o || typeof o !== "object") return null;
  const counts = {};
  for (const k of KINDS) counts[k] = num(o.counts && o.counts[k]);
  return { total: num(o.total), counts, opretBytes: num(o.opretBytes), height: num(o.height) };
}

function sanitizeTxTypes(t) {
  if (!t || typeof t !== "object") return null;
  return {
    mempool: sanitizeKinds(t.mempool),
    blocks: Array.isArray(t.blocks) ? t.blocks.slice(0, 6).map(sanitizeKinds).filter(Boolean) : [],
  };
}

function sanitizePolicy(p) {
  if (!p || typeof p !== "object") return null;
  const out = {};
  for (const k of ["minrelaytxfee", "dustrelayfee", "datacarriersize", "bytespersigop", "maxmempool", "limitclustercount", "limitclustersize"]) out[k] = num(p[k]);
  for (const k of ["permitbaremultisig", "acceptnonstdtxn"]) out[k] = bool(p[k]);
  return out;
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
    fees: sanitizeFees(body.fees),
    recent: sanitizeRecent(body.recent),
    policy: sanitizePolicy(body.policy),
    txtypes: sanitizeTxTypes(body.txtypes),
    final: sanitizeFinal(body.final),
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
  if (raw.length > 40000) return new Response("too large", { status: 413 });
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
    sh: snap.bitaxe && snap.bitaxe.online ? snap.bitaxe.accepted : null,
    tf: declaredFees(snap.dmnd),
    ad: snap.dmnd ? snap.dmnd.activeId : null,
    dl: snap.dmnd && snap.dmnd.pool ? num(snap.dmnd.pool.declaration_latency_ms) : null,
  });
  const bd = snap.bitaxe && snap.bitaxe.online ? parseDiff(snap.bitaxe.bestDiff) : null;
  state.shares = state.shares || [];
  if (bd !== null && bd > (state.bestShare || 0)) {
    state.shares.push({ t: snap.t, diff: snap.bitaxe.bestDiff, v: bd });
    state.shares = state.shares.slice(-25);
    state.bestShare = bd;
  }
  // My declared template per block height, compared with the block that was actually mined.
  state.mine = state.mine || {};
  // Exact: the last template declared before the block was found (recorded locally by template_watch.py).
  for (const f of snap.final || []) {
    state.mine[f.height] = { fees: f.fees, tx: f.txCount, full: f.fullness, t: snap.t, ex: true, age: f.age };
  }
  const dc = snap.dmnd && snap.dmnd.templates ? snap.dmnd.templates.find((t) => t.declared === true) : null;
  if (dc && dc.height && !(state.mine[dc.height] && state.mine[dc.height].ex)) {
    state.mine[dc.height] = { fees: dc.fees, tx: dc.txCount, full: dc.fullness, t: snap.t };
  }
  // Older comparisons used a 2-minute snapshot of my template; keep only exact ones.
  state.vs = (state.vs || []).filter((v) => v.ex);
  for (const b of snap.recent || []) {
    const m = state.mine[b.height];
    if (m && m.ex && b.fees !== null && !state.vs.some((v) => v.h === b.height)) {
      state.vs.push({ h: b.height, time: b.time, pool: b.pool, mf: m.fees, mt: m.tx, mfull: m.full, mtime: m.t,
                      age: m.age, ex: true, rf: b.fees, rt: b.txs, rfull: b.weight ? b.weight / 40000 : null });
    }
  }
  state.vs.sort((a, b) => a.h - b.h);
  state.vs = state.vs.slice(-30);
  const keep = Object.keys(state.mine).map(Number).sort((a, b) => b - a).slice(0, 12);
  for (const k of Object.keys(state.mine)) if (!keep.includes(Number(k))) delete state.mine[k];
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
<title>SV2 Home Mining</title>
<style>
:root{--bg:#f6f5f1;--card:#fff;--ink:#1b1b18;--mute:#6b6a63;--line:#e4e2da;--accent:#e8820c;--accent-soft:#fbe7cf;--hash:#1f8f4e;--hash-soft:#d9efe2;--ok:#1f8f4e;--bad:#c0392b;--bar:#ece9df;--region:#f1efe8}
@media (prefers-color-scheme:dark){:root{--bg:#141412;--card:#1d1d1a;--ink:#ecebe5;--mute:#9a988f;--line:#34332e;--accent:#f5a03a;--accent-soft:#3b2a14;--hash:#4cc27f;--hash-soft:#16301f;--ok:#4cc27f;--bad:#ef6b5b;--bar:#2a2926;--region:#191916}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:1000px;margin:0 auto;padding:24px 16px 48px}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start;justify-content:space-between;margin-bottom:16px}
.eyebrow{font-size:12px;color:var(--accent);font-weight:700;text-transform:uppercase;letter-spacing:.07em;margin-bottom:4px}
h1{font-size:26px;margin:0;letter-spacing:-.015em;line-height:1.2}
.pill{display:inline-flex;align-items:center;gap:7px;padding:5px 12px;border-radius:99px;font-size:13px;font-weight:650;border:1px solid var(--line);background:var(--card);white-space:nowrap}
.pill i{width:8px;height:8px;border-radius:50%;background:var(--mute)}
.pill.ok{color:var(--ok)}.pill.ok i{background:var(--ok);animation:pulse 1.6s ease-in-out infinite}
.pill.sync{color:var(--accent)}.pill.sync i{background:var(--accent)}
.pill.bad{color:var(--bad)}.pill.bad i{background:var(--bad)}
@keyframes pulse{50%{opacity:.35}}
.sub{color:var(--mute);font-size:13px;margin-top:4px}
nav{display:flex;gap:6px;margin:0 0 16px}
nav button{font:inherit;padding:6px 14px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--mute);cursor:pointer}
nav button[aria-selected=true]{color:var(--ink);border-color:var(--accent)}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px}
.hero{padding:16px 16px 12px}
.story{margin:0 0 12px;padding:2px 0 2px 14px;border-left:4px solid var(--accent);line-height:1.55}
.story.ok{border-left-color:var(--ok)}.story.bad{border-left-color:var(--bad)}
.legend{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:12px;color:var(--mute);margin-top:8px}
.legend span{display:inline-flex;align-items:center;gap:7px}
.legend b{display:inline-block;width:22px;height:0;border-top:3px dashed}
.legend .lt b{border-color:var(--accent)}.legend .lh b{border-color:var(--hash)}
.dg{width:100%;height:auto;display:block}
.dg .rg{fill:var(--region);stroke:var(--line);stroke-dasharray:5 5}
.dg .rl{font-size:11px;fill:var(--mute);letter-spacing:.07em;font-weight:600}
.dg .bx{fill:var(--card);stroke:var(--line);stroke-width:1.5}
.dg .bx.hl{stroke:var(--accent);stroke-width:2}
.dg .t{font-size:14px;font-weight:700;fill:var(--ink)}
.dg .m{font-size:18px;font-weight:700;fill:var(--ink)}
.dg .s{font-size:12px;fill:var(--mute)}
.dg .dt{fill:var(--mute)}.dg .dt.on{fill:var(--ok)}.dg .dt.off{fill:var(--bad)}
.dg .lk{fill:none;stroke:var(--line);stroke-width:3;stroke-linecap:round;stroke-linejoin:round}
.dg .lk.tp.live{stroke:var(--accent)}.dg .lk.hs.live{stroke:var(--hash)}
.dg .lk.live{stroke-dasharray:9 7;animation:flow .9s linear infinite}
.dg .lk.dead{stroke:var(--bad);stroke-dasharray:2 7;opacity:.7}
.dg .ll{font-size:11px;fill:var(--mute);font-weight:600}
@keyframes flow{to{stroke-dashoffset:-16}}
@media (prefers-reduced-motion:reduce){.dg .lk.live,.pill.ok i{animation:none}}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:12px 0}
.kpi .k,.stat .k,.k{color:var(--mute);font-size:12px;text-transform:uppercase;letter-spacing:.05em}
.kpi .v{font-size:26px;font-weight:700;letter-spacing:-.01em;margin-top:2px;word-break:break-word}
.kpi .s,.stat .s{color:var(--mute);font-size:12px;margin-top:2px}
.kpi.t{border-top:3px solid var(--accent)}.kpi.h{border-top:3px solid var(--hash)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin:12px 0}
.stat .v{font-size:21px;font-weight:650;margin-top:2px;word-break:break-word}
.stat.dim{opacity:.55}
h2.sec{display:flex;align-items:center;gap:10px;font-size:18px;margin:30px 0 4px;letter-spacing:-.01em}
h2.sec .tag{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;padding:2px 8px;border-radius:99px}
.tag.t{background:var(--accent-soft);color:var(--accent)}.tag.h{background:var(--hash-soft);color:var(--hash)}.tag.n{background:var(--bar);color:var(--mute)}
.lead{color:var(--mute);font-size:14px;margin:0 0 4px;max-width:760px}
.two{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px;margin:12px 0}
.blkh{display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap}
.big2{font-size:30px;font-weight:750;letter-spacing:-.02em}
.mlab{display:flex;justify-content:space-between;font-size:12px;color:var(--mute);margin-top:14px}
.mlab b{color:var(--ink);font-weight:650}
.bar{height:12px;border-radius:99px;background:var(--bar);overflow:hidden;margin:6px 0 4px;display:flex}
.bar>i{display:block;height:100%;background:var(--accent);width:0}
.bar>i.h{background:var(--hash)}
.bar.tall{height:22px;border-radius:8px}
.keyrow{display:flex;flex-wrap:wrap;gap:4px 16px;font-size:12px;color:var(--mute)}
.keyrow span{display:inline-flex;align-items:center;gap:6px}
.keyrow b{display:inline-block;width:10px;height:10px;border-radius:3px}
.mini{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:14px;border-top:1px solid var(--line);padding-top:12px}
.mini .v{font-size:17px;font-weight:650}
.cand{padding:10px 0;border-bottom:1px solid var(--line)}
.cand:last-child{border-bottom:0}
.cand .r{display:flex;justify-content:space-between;gap:8px;font-size:14px}
.cand .r b{font-weight:650}
.cand.decl .nm{color:var(--accent);font-weight:700}
.cand .bar{height:8px;margin:6px 0 2px}
.gauges{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:12px 0}
.gauge{text-align:center;padding:12px 10px 8px}
.gauge svg{max-width:160px;margin:0 auto}
.gauge .note{margin-top:-6px}
.gauge .gv{font-size:20px;font-weight:700;fill:var(--ink)}
.gauge .gs{font-size:11px;fill:var(--mute)}
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px;margin:12px 0}
.chart h3{font-size:14px;margin:0 0 8px}
.chart svg{width:100%;height:auto;display:block}
.ax{fill:var(--mute);font-size:10px}
.empty{color:var(--mute);padding:24px 0;text-align:center}
.note{color:var(--mute);font-size:12px;margin:6px 2px 0}
.feed .r{display:flex;justify-content:space-between;gap:8px;font-size:13px;padding:6px 0;border-bottom:1px solid var(--line)}
.feed .r:last-child{border-bottom:0}
.under{margin-top:44px;padding-top:8px;border-top:2px dashed var(--line)}
.prog .row{display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap}
.prog .big{font-size:26px;font-weight:700}
footer{margin-top:28px;color:var(--mute);font-size:12px}
@media (max-width:480px){.kpi .v{font-size:21px}h1{font-size:22px}.big2{font-size:26px}}
.sub3{font-size:16px;margin:24px 0 4px}
.vsr{padding:12px 0;border-bottom:1px solid var(--line)}
.vsr .r{display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap}
.vl{display:flex;align-items:center;gap:8px;font-size:12px;margin:6px 0}
.vl .lbl{width:88px;color:var(--mute);flex:none}.vl .bar{flex:1;margin:0;height:10px}.vl .val{width:86px;text-align:right;flex:none}
.bar>i.g{background:var(--mute)}
.tagline{display:inline-block;margin-top:6px;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--accent-soft);color:var(--accent);padding:2px 8px;border-radius:6px}
.pr{display:grid;grid-template-columns:1fr auto auto;gap:2px 12px;align-items:baseline;padding:8px 0;border-bottom:1px solid var(--line);font-size:13px}
.pr:last-child{border-bottom:0}.pr .d{grid-column:1/-1;color:var(--mute);font-size:12px}
.pr .mv{font-weight:650;text-align:right}.pr .dv{color:var(--mute);text-align:right;font-size:12px}
.badge{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;padding:1px 6px;border-radius:99px;margin-left:6px;vertical-align:middle}
.badge.p{background:var(--hash-soft);color:var(--hash)}.badge.s{background:var(--accent-soft);color:var(--accent)}.badge.x{background:var(--bar);color:var(--mute)}
.mx{margin:8px 0}.mx .r{display:flex;justify-content:space-between;font-size:13px}.mx .bar{height:8px;margin:4px 0 0}
table.hm{border-collapse:collapse;width:100%;font-size:12px;margin-top:8px;min-width:520px}
table.hm th{color:var(--mute);font-weight:600;text-align:right;padding:4px 6px}table.hm th:first-child,table.hm td:first-child{text-align:left}
table.hm td{text-align:right;padding:6px;border-top:1px solid var(--line)}
[hidden]{display:none!important}
</style></head><body><div class="wrap">
<header>
  <div>
    <div class="eyebrow">Stratum V2 &middot; Job Declaration &middot; home mining</div>
    <h1>Mining on block templates from my own node</h1>
    <div class="sub" id="meta">loading&hellip;</div>
  </div>
  <span class="pill" id="status"><i></i><span id="statustxt">&hellip;</span></span>
</header>
<nav role="tablist">
  <button role="tab" id="t-status" aria-selected="true">Live</button>
  <button role="tab" id="t-pools" aria-selected="false">Pools</button>
</nav>

<section id="p-status">
  <div class="card hero">
    <p class="story" id="story">loading&hellip;</p>
    <div id="diagram"></div>
    <div class="legend">
      <span class="lt"><b></b>Block templates and job declaration (Stratum V2)</span>
      <span class="lh"><b></b>Hashes and shares</span>
      <span>Moving lines are live</span>
    </div>
  </div>
  <div class="kpis" id="kpis"></div>

  <h2 class="sec">The block I&rsquo;m mining <span class="tag t">Job Declaration</span></h2>
  <p class="lead" id="tpnote"></p>
  <div class="two" id="blockviz"></div>
  <div class="charts">
    <div class="card chart"><h3>Fees in the declared block (million sats)</h3><div id="c7"></div></div>
    <div class="card chart"><h3>Templates declared to the pool</h3><div id="c9"></div></div>
  </div>
  <h3 class="sub3">My template vs the block that was mined</h3>
  <p class="lead" id="vsnote"></p>
  <div class="kpis" id="vsk"></div>
  <div class="card" id="vs"></div>

  <h2 class="sec">DMND client <span class="tag t">Stratum V2 proxy</span></h2>
  <p class="lead">Runs on this laptop. Speaks Stratum V1 to the Bitaxe, Stratum V2 to the pool, and Template Distribution to sv2-tp.</p>
  <div class="grid" id="cpg"></div>
  <div class="charts">
    <div class="card chart"><h3>Shares accepted (Bitaxe)</h3><div id="c8"></div></div>
    <div class="card chart"><h3>Declaration latency (ms)</h3><div id="c10"></div></div>
  </div>

  <h2 class="sec">Bitaxe Gamma <span class="tag h">Miner</span></h2>
  <p class="lead">A single BM1370 chip on my home network, pointed at the DMND client.</p>
  <div class="gauges" id="gauges"></div>
  <div class="grid" id="bx"></div>
  <div class="charts">
    <div class="card chart"><h3>Hashrate (GH/s)</h3><div id="c5"></div></div>
    <div class="card chart"><h3>ASIC temperature (&deg;C)</h3><div id="c6"></div></div>
  </div>
  <div class="two">
    <div class="card"><div class="k">Best shares found</div><div class="feed" id="sf"></div></div>
    <div class="card"><div class="k">Odds of finding a block</div><div class="grid" id="odds" style="grid-template-columns:repeat(2,1fr);margin-bottom:4px"></div><div class="note" id="oddsnote"></div></div>
  </div>

  <h2 class="sec">What my node accepts <span class="tag t">Relay policy</span></h2>
  <p class="lead">With Stratum V2 my own node picks the transactions in my block, so its relay policy decides what can be mined. Bitcoin Core does not allow truly non-standard transactions on mainnet, but its defaults already accept most edge cases.</p>
  <div class="two">
    <div class="card"><div class="k">Policy &middot; mine vs Bitcoin Core default</div><div id="pol"></div></div>
    <div class="card"><div class="k">What is in my mempool</div><div id="mix"></div></div>
  </div>
  <div class="card"><div class="k">Transaction types in recent blocks</div><div id="mixb" style="overflow-x:auto"></div></div>

  <div class="under">
    <h2 class="sec">Bitcoin node <span class="tag n">Under the hood</span></h2>
    <p class="lead">Bitcoin Core in multiprocess mode, pruned, feeding sv2-tp over IPC.</p>
    <div class="card prog">
      <div class="row"><span class="big" id="pct">&ndash;</span><span class="sub" id="pdetail"></span></div>
      <div class="bar"><i id="barfill"></i></div>
      <div class="sub" id="pmore"></div>
    </div>
    <div class="grid" id="stats"></div>
    <h2 class="sec" style="font-size:15px">Fee market</h2>
    <p class="lead" id="fmnote"></p>
    <div class="grid" id="fm"></div>
    <div class="card" id="fmb" hidden></div>
    <h2 class="sec" style="font-size:15px">Latest blocks</h2>
    <p class="lead" id="rbnote"></p>
    <div class="grid" id="rb"></div>
    <div class="charts">
      <div class="card chart"><h3>Blocks validated</h3><div id="c1"></div></div>
      <div class="card chart"><h3>Sync speed (blocks/min)</h3><div id="c2"></div></div>
      <div class="card chart"><h3>Connected peers</h3><div id="c3"></div></div>
      <div class="card chart"><h3>Disk used (GB)</h3><div id="c4"></div></div>
    </div>
  </div>
</section>

<section id="p-pools" hidden>
  <div class="card">
    <div class="big2" id="poolpct">&ndash;</div>
    <div class="bar"><i id="poolbar"></i></div>
    <div class="sub" id="pooltxt"></div>
  </div>
  <div class="card empty" style="margin-top:12px">
    Pool hashrate shares are computed from the coinbase of recent blocks. Not wired up yet.
  </div>
</section>

<footer>Aggregate statistics only: no transactions, addresses, wallet or machine details are published. Updates about every 2 minutes.</footer>
</div>
<script>
(function(){
var $=function(id){return document.getElementById(id)};
var NS='http://www.w3.org/2000/svg',LAST=null;
function fmt(n){return n==null?'–':Number(n).toLocaleString('en-US')}
function gb(b){return b==null?'–':(b/1e9).toFixed(1)+' GB'}
function ago(s){if(s<90)return s+'s ago';if(s<5400)return Math.round(s/60)+' min ago';if(s<172800)return Math.round(s/3600)+' h ago';return Math.round(s/86400)+' d ago'}
function dur(s){if(s==null)return '–';var d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return d?d+'d '+h+'h':h?h+'h '+m+'m':m+'m'}
function dstr(t){return t?new Date(t*1000).toISOString().slice(0,10):'–'}
function hb(b){if(b==null)return '–';var u=['B','KB','MB','GB','TB'],i=0;while(b>=1024&&i<4){b/=1024;i++}return b.toFixed(i>1?1:0)+' '+u[i]}
function nets(o){if(!o)return '–';var k=Object.keys(o);if(!k.length)return '–';return k.map(function(n){return n+' '+o[n]}).join(' · ')}
function hrate(g){return g==null?'–':g>=1000?(g/1000).toFixed(2)+' TH/s':g.toFixed(0)+' GH/s'}
function hnum(n,dp){if(n==null||!isFinite(n))return '–';dp=dp==null?2:dp;var u=[[1e21,'Z'],[1e18,'E'],[1e15,'P'],[1e12,'T'],[1e9,'G'],[1e6,'M'],[1e3,'K']];for(var i=0;i<u.length;i++){if(n>=u[i][0])return (n/u[i][0]).toFixed(dp)+' '+u[i][1]}return n.toFixed(0)}
function parseDiff(s){if(s==null)return null;var m=/^([0-9.]+)\s*([KMGTPE]?)$/i.exec(String(s).trim());if(!m)return null;var f={'':1,K:1e3,M:1e6,G:1e9,T:1e12,P:1e15,E:1e18}[m[2].toUpperCase()];return parseFloat(m[1])*f}
function years(sec){var y=sec/31557600;if(y>=1e9)return (y/1e9).toFixed(1)+' billion years';if(y>=1e6)return (y/1e6).toFixed(1)+' million years';if(y>=1e3)return Math.round(y).toLocaleString('en-US')+' years';if(y>=1)return y.toFixed(1)+' years';return Math.max(1,Math.round(sec/86400))+' days'}
function dif(x){var v=parseDiff(x);return v==null?(x||'–'):hnum(v,v>=1e3?2:0)}
function words(n){if(n==null||!isFinite(n))return '–';var u=[[1e12,' trillion'],[1e9,' billion'],[1e6,' million'],[1e3,' thousand']];for(var i=0;i<u.length;i++){if(n>=u[i][0])return (n/u[i][0]).toFixed(1)+u[i][1]}return n.toFixed(0)}
function sats(n){return n==null?'–':fmt(Math.round(n))+' sats'}
function btc(n){return n==null?'–':(n/1e8).toFixed(n<1e7?4:3)+' BTC'}
function clip(s,n){s=String(s);return s.length>n?s.slice(0,n-1)+'…':s}
function el(tag,cls,txt){var d=document.createElement(tag);if(cls)d.className=cls;if(txt!=null)d.textContent=txt;return d}
function sv(tag,a,txt){var n=document.createElementNS(NS,tag);for(var k in a)n.setAttribute(k,a[k]);if(txt!=null)n.textContent=txt;return n}
function stat(k,v,s,cls){var d=el('div','card stat'+(cls?' '+cls:''));d.appendChild(el('div','k',k));d.appendChild(el('div','v',v));if(s)d.appendChild(el('div','s',s));return d}
function kpi(k,v,s,c){var d=el('div','card kpi '+(c||''));d.appendChild(el('div','k',k));d.appendChild(el('div','v',v));if(s)d.appendChild(el('div','s',s));return d}
function dimmed(g,names,why){names.forEach(function(n){g.appendChild(stat(n,'–',why,'dim'))})}

function derive(s){
  var l=s.latest,age=s.now-l.t,stale=age>600;
  var synced=l.ibd===false&&l.blocks>=l.headers-2;
  var sv0=l.services||{},bx=l.bitaxe,d=l.dmnd||null,t=d&&d.templates||[];
  var decl=null;t.forEach(function(x){if(x.declared)decl=x});
  var hashing=!!(bx&&bx.online&&bx.hashrate>0);
  var lat=d&&d.pool&&d.pool.declaration_latency_ms!=null?d.pool.declaration_latency_ms:null;
  var k={ipc:!stale&&!!sv0.ipc,tpl:!stale&&!!sv0.tp&&synced&&t.length>0,decl:!stale&&!!decl,
         shares:!stale&&hashing&&sv0.miners>0,jobs:!stale&&sv0.miners>0&&!!decl};
  var dead={ipc:!sv0.ipc,tpl:!sv0.tp,decl:!sv0.client,shares:!sv0.client||(bx&&!bx.online),jobs:!sv0.client};
  return {l:l,age:age,stale:stale,synced:synced,pct:l.progress==null?null:l.progress*100,sv:sv0,bx:bx,d:d,t:t,decl:decl,hashing:hashing,lat:lat,k:k,dead:dead};
}

/* ---------- live SV2 diagram ---------- */
var WIDE={W:980,H:310,bw:180,bh:88,
  n:{node:[10,40],tp:[270,40],client:[530,40],pool:[790,40],bitaxe:[530,210]},
  region:[0,8,722,136],rl:[14,28,'start','THIS LAPTOP'],pl:[790,28,'start','INTERNET'],bl:[520,258,'end','HOME NETWORK'],
  links:[['ipc','tp','M190 84 L270 84',[230,76,'middle'],'IPC'],
         ['tpl','tp','M450 84 L530 84',[490,76,'middle'],'Templates'],
         ['decl','tp','M710 72 L790 72',[750,62,'middle'],'Declare jobs'],
         ['shares','hs','M710 100 L790 100',[750,118,'middle'],'Shares'],
         ['shares','hs','M600 210 L600 128',[592,174,'end'],'Shares'],
         ['jobs','tp','M640 128 L640 210',[648,174,'start'],'Jobs']]};
var TALL={W:360,H:700,bw:220,bh:84,
  n:{node:[120,36],tp:[120,176],client:[120,316],pool:[120,476],bitaxe:[120,606]},
  region:[100,8,252,400],rl:[112,26,'start','THIS LAPTOP'],pl:[120,468,'start','INTERNET'],bl:[120,598,'start','HOME NETWORK'],
  links:[['ipc','tp','M230 120 L230 176',[238,152,'start'],'IPC'],
         ['tpl','tp','M230 260 L230 316',[238,292,'start'],'Templates'],
         ['decl','tp','M205 400 L205 476',[197,442,'end'],'Declare jobs'],
         ['shares','hs','M255 400 L255 476',[263,442,'start'],'Shares'],
         ['shares','hs','M120 660 L40 660 L40 344 L120 344',[30,500,'rot'],'Shares'],
         ['jobs','tp','M120 372 L70 372 L70 632 L120 632',[84,500,'rot'],'Jobs']]};
function renderDiagram(st){
  var host=$('diagram');host.textContent='';
  var L=host.clientWidth>=680?WIDE:TALL,svg=sv('svg',{viewBox:'0 0 '+L.W+' '+L.H,'class':'dg',role:'img','aria-label':'Live diagram of the Stratum V2 mining stack'});
  var r=L.region;svg.appendChild(sv('rect',{x:r[0],y:r[1],width:r[2],height:r[3],rx:16,'class':'rg'}));
  [L.rl,L.pl,L.bl].forEach(function(q){svg.appendChild(sv('text',{x:q[0],y:q[1],'text-anchor':q[2],'class':'rl'},q[3]))});
  L.links.forEach(function(k){
    var state=st.stale?'dead':st.k[k[0]]?'live':st.dead[k[0]]?'dead':'';
    svg.appendChild(sv('path',{d:k[2],'class':'lk '+k[1]+' '+state}));
  });
  L.links.forEach(function(k){var p=k[3],a={x:p[0],y:p[1],'class':'ll','text-anchor':p[2]==='rot'?'middle':p[2]};
    if(p[2]==='rot')a.transform='rotate(-90 '+p[0]+' '+p[1]+')';svg.appendChild(sv('text',a,k[4]))});
  var l=st.l,sv0=st.sv,bx=st.bx,d=st.d,w=L.bw,h=L.bh,ml=w>200?19:16,sl=w>200?31:25;
  function box(key,title,on,main,sub,hl){var p=L.n[key],x=p[0],y=p[1],g=sv('g',{});
    g.appendChild(sv('rect',{x:x,y:y,width:w,height:h,rx:12,'class':'bx'+(hl?' hl':'')}));
    g.appendChild(sv('circle',{cx:x+w-16,cy:y+20,r:5,'class':'dt '+(on===true?'on':on===false?'off':'')}));
    g.appendChild(sv('text',{x:x+14,y:y+25,'class':'t'},title));
    g.appendChild(sv('text',{x:x+14,y:y+53,'class':'m'},clip(main,ml)));
    if(sub)g.appendChild(sv('text',{x:x+14,y:y+74,'class':'s'},clip(sub,sl)));
    svg.appendChild(g)}
  var ver=(l.version||'').replace(/^Satoshi:/,'v');
  box('node','Bitcoin node',!st.stale,st.synced?'Block '+fmt(l.blocks):(st.pct==null?'–':st.pct.toFixed(1)+'% synced'),'Core '+ver+' · '+fmt((l.peersIn||0)+(l.peersOut||0))+' peers');
  box('tp','sv2-tp',st.stale?false:!!sv0.tp,!sv0.tp?'Down':st.synced?(st.t.length?'Building blocks':'Serving'):'Waiting for sync','Template Provider · '+dur(sv0.tpUptime));
  box('client','DMND client',st.stale?false:!!sv0.client,!sv0.client?'Down':st.decl?(d.activeId!=null?'Template #'+fmt(d.activeId):'Declaring'):'Connecting',fmt(sv0.miners)+' miner'+(sv0.miners===1?'':'s')+' · up '+dur(sv0.clientUptime),!!st.decl);
  box('pool','DMND pool',st.k.decl?true:null,st.lat!=null?Math.round(st.lat)+' ms':st.k.decl?'Accepting':'–',st.lat!=null?'declaration latency':'external pool');
  box('bitaxe','Bitaxe Gamma',bx?bx.online:null,bx&&bx.online?hrate(bx.hashrate):bx?'Offline':'–',bx&&bx.online?(bx.temp>0?bx.temp.toFixed(0)+' °C':'idle')+' · '+(bx.power!=null?bx.power.toFixed(1)+' W':'–'):'');
  if(L===TALL)svg.style.maxWidth='400px',svg.style.margin='0 auto';
  host.appendChild(svg);
}
function renderStory(st){
  var e=$('story'),l=st.l,sv0=st.sv,bx=st.bx,msg,cls='';
  if(st.stale){msg='No report from the laptop for '+ago(st.age).replace(' ago','')+'. It may be asleep or offline.';cls='bad'}
  else if(!sv0.ipc){msg='The node is not running in multiprocess mode, so sv2-tp cannot reach it.';cls='bad'}
  else if(!st.synced){msg='The node is syncing ('+(st.pct==null?'0':st.pct.toFixed(1))+'%). Templates start flowing once it reaches the chain tip.'}
  else if(!sv0.tp){msg='sv2-tp is down, so my node is not building templates for the pool.';cls='bad'}
  else if(!sv0.client){msg='The DMND client is down, so nothing is declared to the pool and the Bitaxe has nowhere to send work.';cls='bad'}
  else if(st.hashing&&st.decl){msg='Live: the Bitaxe is hashing at '+hrate(bx.hashrate)+' on block '+fmt(st.decl.height)+', a block template my own node built and the DMND client declared to the pool. The pool checks the work but did not choose the transactions.';cls='ok'}
  else if(st.decl){msg='My node is building templates and the DMND client is declaring them to the pool. Waiting for the Bitaxe to hash.'}
  else{msg='The stack is up. Waiting for the first template to be declared to the pool.'}
  e.textContent=msg;e.className='story '+cls;
}
function declInterval(h){
  var i=h.length-1;while(i>=0&&h[i].ad==null)i--;if(i<0)return null;
  var cur=h[i],j=i;
  while(j>0&&h[j-1].ad!=null&&h[j-1].ad<=h[j].ad&&cur.t-h[j-1].t<=3600)j--;
  var dt=cur.t-h[j].t,dn=cur.ad-h[j].ad;return dn>0&&dt>=120?dt/dn:null;
}
function renderKpis(st,s){
  var g=$('kpis'),bx=st.bx,d=st.d,dc=st.decl;g.textContent='';
  var iv=declInterval(s.history),acc=d&&d.stats?d.stats.aggregate_accepted_shares:null;
  if(acc==null&&bx)acc=bx.accepted;
  g.appendChild(kpi('Hashrate',bx&&bx.online?hrate(bx.hashrate):'–','Bitaxe Gamma','h'));
  g.appendChild(kpi('Templates declared',d&&d.activeId!=null?fmt(d.activeId):'–',iv?'a new one every ~'+Math.round(iv)+' s':'since the client started','t'));
  g.appendChild(kpi('Fees in my block',dc?btc(dc.fees):'–',dc&&dc.gained?'+'+fmt(dc.gained)+' sats vs first template':'declared template','t'));
  g.appendChild(kpi('Shares accepted',fmt(acc),d&&d.stats&&d.stats.aggregate_rejected_shares!=null?fmt(d.stats.aggregate_rejected_shares)+' rejected':'by the pool','h'));
  g.appendChild(kpi('Declaration latency',st.lat!=null?Math.round(st.lat)+' ms':'–','pool reply to my job','t'));
}

/* ---------- the block I'm mining ---------- */
function renderBlock(st){
  var host=$('blockviz'),nt=$('tpnote'),t=st.t.slice(),d=st.d;host.textContent='';
  if(!t.length){nt.textContent=st.synced?'Waiting for the DMND client to report block templates.':'Once the node is synced, sv2-tp builds candidate blocks from its own mempool and the DMND client declares the best one to the pool.';
    var c=el('div','card empty');c.textContent='No block templates yet';host.appendChild(c);return}
  nt.textContent='Every few seconds my node builds a fresh candidate block from its own mempool. The DMND client keeps the latest '+t.length+', declares the one with the highest fees to the pool, and hands it to the Bitaxe as work. Totals only: no transactions are published.';
  var dc=st.decl||t[0],c1=el('div','card');
  var hd=el('div','blkh');hd.appendChild(el('div','k',dc.declared?'Declared block template':'Latest block template'));hd.appendChild(el('div','k','candidate for the next block'));c1.appendChild(hd);
  c1.appendChild(el('div','big2',dc.height!=null?'Block '+fmt(dc.height):'–'));
  if(d&&d.tag){var tg=el('div','note','Coinbase tag ');tg.appendChild(el('span','tagline',d.tag));c1.appendChild(tg)}
  function meter(label,val,pct,cls){var m=el('div','mlab');m.appendChild(el('span',null,label));var b=el('b',null,val);m.appendChild(b);c1.appendChild(m);
    var bar=el('div','bar tall'),i=el('i',cls||'');i.style.width=Math.max(0,Math.min(100,pct||0))+'%';bar.appendChild(i);c1.appendChild(bar)}
  meter('Block space used',dc.fullness==null?'–':dc.fullness.toFixed(2)+'%',dc.fullness);
  var subs=dc.coinbase!=null&&dc.fees!=null?dc.coinbase-dc.fees:null;
  var m=el('div','mlab');m.appendChild(el('span',null,'What this block would pay'));m.appendChild(el('b',null,btc(dc.coinbase)));c1.appendChild(m);
  var bar=el('div','bar tall');
  if(subs!=null&&dc.coinbase>0){var a=el('i','h');a.style.width=(subs/dc.coinbase*100)+'%';var f=el('i');f.style.width=Math.max(1.2,dc.fees/dc.coinbase*100)+'%';bar.appendChild(a);bar.appendChild(f)}
  c1.appendChild(bar);
  var kr=el('div','keyrow');
  function key(color,txt){var sp=el('span');var b=el('b');b.style.background=color;sp.appendChild(b);sp.appendChild(document.createTextNode(txt));kr.appendChild(sp)}
  key('var(--hash)','Subsidy '+btc(subs));key('var(--accent)','Fees '+btc(dc.fees)+(dc.coinbase?' ('+(dc.fees/dc.coinbase*100).toFixed(2)+'%)':''));c1.appendChild(kr);
  var mini=el('div','mini');
  [['Transactions',fmt(dc.txCount)],['Avg fee rate',dc.feeRate==null?'–':dc.feeRate.toFixed(1)+' sat/vB'],['Accelerated',dc.accel==null?fmt(dc.prioritized):fmt(dc.accel)+(dc.prioritized?' + '+fmt(dc.prioritized)+' manual':'')]].forEach(function(q){var x=el('div');x.appendChild(el('div','k',q[0]));x.appendChild(el('div','v',q[1]));mini.appendChild(x)});
  c1.appendChild(mini);host.appendChild(c1);
  var c2=el('div','card');c2.appendChild(el('div','k','Candidates · policy: '+(d&&d.policy?d.policy.replace(/_/g,' '):'highest fees')));
  t.sort(function(a,b){return (b.fees||0)-(a.fees||0)});
  var mx=Math.max.apply(null,t.map(function(x){return x.gained||0}));
  t.forEach(function(x,i){var r=el('div','cand'+(x.declared?' decl':''));
    var top=el('div','r');top.appendChild(el('span','nm',x.declared?'Declared':'Candidate '+(i+1)));top.appendChild(el('b',null,sats(x.fees)));r.appendChild(top);
    var br=el('div','bar'),fi=el('i');fi.style.width=(mx>0?Math.max(2,(x.gained||0)/mx*100):2)+'%';if(!x.declared)fi.style.opacity='.45';br.appendChild(fi);r.appendChild(br);
    r.appendChild(el('div','note',(x.gained==null?'':(x.gained>0?'+'+fmt(x.gained)+' sats':'baseline')+' vs the first template for this block')+(x.txCount!=null?' · '+fmt(x.txCount)+' tx':'')));
    c2.appendChild(r)});
  c2.appendChild(el('div','note','Fees grow as new transactions reach the mempool, so newer templates usually pay more. The client switches the Bitaxe to the best one.'));
  host.appendChild(c2);
}

/* ---------- DMND client ---------- */
function renderVs(s){
  var v=(s.vs||[]).slice().reverse(),box=$('vs'),k=$('vsk'),nt=$('vsnote');box.textContent='';k.textContent='';
  nt.textContent='When a block is found, the last template my node declared for that height is lined up against the block the network actually mined. Same height, two independent choices of transactions.';
  if(!v.length){k.hidden=true;box.appendChild(el('div','empty','Waiting for the next block. Comparisons appear as blocks are found (about every 10 minutes).'));return}
  k.hidden=false;
  var more=0,sum=0;v.forEach(function(x){var d=x.mf-x.rf;if(d>0)more++;sum+=x.rf?d/x.rf*100:0});
  var avg=sum/v.length;
  k.appendChild(kpi('Blocks compared',fmt(v.length),'since tracking started','t'));
  k.appendChild(kpi('Mine paid more',more+' of '+v.length,'my template had higher fees','t'));
  k.appendChild(kpi('Average difference',(avg>=0?'+':'')+avg.toFixed(1)+'%','my fees vs the real block','t'));
  var mx=Math.max.apply(null,v.map(function(x){return Math.max(x.mf||0,x.rf||0)}));
  v.slice(0,8).forEach(function(x){
    var r=el('div','vsr'),hd=el('div','r');
    hd.appendChild(el('b',null,'Block '+fmt(x.h)));hd.appendChild(el('span','note',(x.pool?'mined by '+x.pool:'pool unknown')+' · '+ago(Math.max(0,s.now-x.time))));r.appendChild(hd);
    function line(lbl,val,cls){var row=el('div','vl');row.appendChild(el('span','lbl',lbl));var b=el('div','bar'),i=el('i',cls);i.style.width=(mx&&val?val/mx*100:0)+'%';b.appendChild(i);row.appendChild(b);row.appendChild(el('span','val',btc(val)));r.appendChild(row)}
    line('My template',x.mf,'');line('Real block',x.rf,'g');
    var d=(x.mf||0)-(x.rf||0),pc=x.rf?d/x.rf*100:0;
    r.appendChild(el('div','note',(d>=0?'+':'−')+fmt(Math.abs(Math.round(d)))+' sats ('+(pc>=0?'+':'−')+Math.abs(pc).toFixed(1)+'%) · '+fmt(x.mt)+' vs '+fmt(x.rt)+' transactions'+(x.age!=null?' · my template was '+x.age+'s old':'')));
    box.appendChild(r)});
  box.appendChild(el('div','note','My side is the last template my client declared before the block was found, recorded within 2 seconds. Its age is how long it had been in use when the block arrived. A real block can also include transactions its miner received privately or was paid to add outside the mempool.'));
}
var KIND={opreturn:['OP_RETURN data','extra data in an output, up to 100 KB per transaction'],
  inscription:['Inscriptions','data in a Taproot witness envelope (ordinals)'],
  anchor:['Pay-to-anchor','tiny anchor outputs used to bump fees (Lightning, TRUC)'],
  truc:['TRUC (v3)','version 3 transactions with simple fee-bumping rules'],
  baremultisig:['Bare multisig','multisig output without a P2SH wrapper'],
  dust:['Dust outputs','outputs worth less than it costs to spend them'],
  big:['Large (20 kvB+)','unusually big transactions'],
  nonstandardout:['Non-standard outputs','scripts Core would not normally relay']};
var KORDER=['opreturn','inscription','anchor','truc','baremultisig','dust','big','nonstandardout'];
function renderPolicy(l){
  var box=$('pol'),p=l.policy;box.textContent='';
  if(!p){box.appendChild(el('div','note','No policy data yet.'));return}
  var rows=[['minrelaytxfee','Minimum relay fee','sat/vB',0.1,-1,'cheapest fee rate accepted'],
    ['dustrelayfee','Dust threshold fee','sat/vB',3,-1,'0 accepts dust outputs'],
    ['datacarriersize','OP_RETURN data limit','bytes',100000,1,'per transaction, several outputs allowed'],
    ['permitbaremultisig','Bare multisig',null,true,1,'accept multisig without P2SH'],
    ['bytespersigop','Bytes per sigop','',20,-1,'lower accepts sigop-heavy transactions'],
    ['maxmempool','Mempool size','MB',300,1,'memory set aside for unconfirmed transactions'],
    ['limitclustercount','Cluster limit','txs',64,1,'max connected unconfirmed transactions'],
    ['acceptnonstdtxn','Non-standard transactions',null,false,1,'test networks only in Bitcoin Core']];
  function show(v,u){return typeof v==='boolean'?(v?'yes':'no'):v==null?'–':fmt(v)+(u?' '+u:'')}
  rows.forEach(function(r){var v=p[r[0]],d=el('div','pr');
    var name=el('span',null,r[1]),badge;
    if(r[0]==='acceptnonstdtxn')badge=el('span','badge x','mainnet: off');
    else if(v===r[3]||v==null)badge=el('span','badge x','default');
    else{var more=typeof v==='boolean'?v:(r[4]>0?v>r[3]:v<r[3]);badge=el('span','badge '+(more?'p':'s'),more?'more open':'stricter')}
    name.appendChild(badge);d.appendChild(name);d.appendChild(el('span','mv',show(v,r[2])));d.appendChild(el('span','dv','default '+show(r[3],r[2])));
    d.appendChild(el('span','d',r[5]));box.appendChild(d)});
}
function renderMix(l){
  var box=$('mix'),hb2=$('mixb'),t=l.txtypes;box.textContent='';hb2.textContent='';
  if(!t||!t.mempool||!t.mempool.total){box.appendChild(el('div','note','Scanning the mempool. Results appear after the next update.'));hb2.appendChild(el('div','note','Appears once blocks are scanned.'));return}
  var m=t.mempool;box.appendChild(el('div','note',fmt(m.total)+' transactions checked · '+hb(m.opretBytes)+' of OP_RETURN data waiting'));
  KORDER.forEach(function(k){var c=m.counts[k]||0,pc=c/m.total*100,r=el('div','mx'),top=el('div','r');
    var nm=el('span',null,KIND[k][0]);top.appendChild(nm);top.appendChild(el('b',null,fmt(c)+' · '+(pc<1&&c?pc.toFixed(2):pc.toFixed(0))+'%'));r.appendChild(top);
    var bar=el('div','bar'),i=el('i');i.style.width=Math.max(c?1:0,pc)+'%';bar.appendChild(i);r.appendChild(bar);
    r.appendChild(el('div','note',KIND[k][1]));box.appendChild(r)});
  if(!t.blocks.length){hb2.appendChild(el('div','note','Appears once blocks are scanned.'));return}
  var used=KORDER.filter(function(k){return t.blocks.some(function(b){return b.counts[k]})||(m.counts[k]||0)>0});
  var tb=el('table','hm'),hr=el('tr');hr.appendChild(el('th',null,'Block'));hr.appendChild(el('th',null,'Txs'));
  used.forEach(function(k){hr.appendChild(el('th',null,KIND[k][0]))});tb.appendChild(hr);
  t.blocks.forEach(function(b){var tr=el('tr');tr.appendChild(el('td',null,fmt(b.height)));tr.appendChild(el('td',null,fmt(b.total)));
    used.forEach(function(k){var c=b.counts[k]||0,pc=b.total?c/b.total*100:0,td=el('td',null,c?(pc<0.1?'<0.1':pc<1?pc.toFixed(1):pc.toFixed(0))+'%':'–');
      if(c)td.style.background='color-mix(in srgb, var(--accent) '+Math.min(60,Math.max(8,pc*.6)).toFixed(0)+'%, transparent)';tr.appendChild(td)});
    tb.appendChild(tr)});
  hb2.appendChild(tb);hb2.appendChild(el('div','note','Share of each block\'s transactions (coinbase excluded). One transaction can count in several columns.'));
}
function renderClient(st){
  var g=$('cpg'),d=st.d,sv0=st.sv;g.textContent='';
  if(!d){dimmed(g,['Miners connected','Shares accepted','Share difficulty','Declaration latency'],sv0.client?'waiting for client data':'client down');return}
  var s=d.stats||{},p=d.pool||{};
  g.appendChild(stat('Miners connected',fmt(s.total_connected_device!=null?s.total_connected_device:sv0.miners),'over Stratum V1'));
  g.appendChild(stat('Shares accepted',fmt(s.aggregate_accepted_shares),s.aggregate_rejected_shares!=null?fmt(s.aggregate_rejected_shares)+' rejected':''));
  g.appendChild(stat('Share difficulty',s.aggregate_diff!=null?hnum(s.aggregate_diff,1):'–','set by the pool'));
  g.appendChild(stat('Declaration latency',p.declaration_latency_ms!=null?Math.round(p.declaration_latency_ms)+' ms':'–','pool reply to a declared job'));
  g.appendChild(stat('Templates declared',d.activeId!=null?fmt(d.activeId):'–','since the client started'));
  g.appendChild(stat('Pool bandwidth',p.bandwidth_bytes_per_sec!=null?hb(p.bandwidth_bytes_per_sec)+'/s':'–','to and from the pool'));
  g.appendChild(stat('Client uptime',dur(sv0.clientUptime),sv0.client?'running':'down'));
  if(d.tag)g.appendChild(stat('Coinbase tag',d.tag,'written into every template I declare'));
  var pr=d.prio;
  if(pr&&pr.enabled!=null)g.appendChild(stat('Accelerations',pr.enabled?(pr.mempoolSpace!=null?fmt(pr.mempoolSpace)+' active':'on'):'off',pr.enabled?'mempool.space accelerator feed'+(pr.manual?' · '+fmt(pr.manual)+' manual':''):'needs RPC access and an API token'));
}

/* ---------- Bitaxe ---------- */
function gauge(title,val,min,max,txt,sub,warn){
  var c=el('div','card gauge');c.appendChild(el('div','k',title));
  var s=sv('svg',{viewBox:'0 0 160 112'}),cx=80,cy=78,r=58,a0=Math.PI*.75,sw=Math.PI*1.5;
  function pt(a){return (cx+r*Math.cos(a)).toFixed(1)+' '+(cy+r*Math.sin(a)).toFixed(1)}
  function arc(a1,a2){return 'M'+pt(a1)+' A'+r+' '+r+' 0 '+(a2-a1>Math.PI?1:0)+' 1 '+pt(a2)}
  s.appendChild(sv('path',{d:arc(a0,a0+sw),fill:'none',style:'stroke:var(--bar)','stroke-width':12,'stroke-linecap':'round'}));
  var f=val==null?0:Math.max(0,Math.min(1,(val-min)/(max-min)));
  if(f>.004)s.appendChild(sv('path',{d:arc(a0,a0+sw*f),fill:'none',style:'stroke:'+(warn?'var(--bad)':'var(--hash)'),'stroke-width':12,'stroke-linecap':'round'}));
  s.appendChild(sv('text',{x:cx,y:cy+6,'text-anchor':'middle','class':'gv'},txt));
  c.appendChild(s);c.appendChild(el('div','note',sub));return c;
}
function renderBitaxe(st){
  var bx=st.bx,gg=$('gauges'),g=$('bx');gg.textContent='';g.textContent='';
  if(!bx||!bx.online){g.appendChild(stat('Bitaxe',bx?'Offline':'not monitored',bx?'not answering on the network':''));return}
  var th=bx.hashrate!=null?bx.hashrate/1000:null,eff=bx.power!=null&&bx.hashrate?bx.power/(bx.hashrate/1000):null;
  gg.appendChild(gauge('Hashrate',th,0,1.6,th==null?'–':th.toFixed(2),'TH/s · typical 1.2'));
  gg.appendChild(gauge('ASIC temperature',bx.temp>0?bx.temp:null,0,90,bx.temp>0?bx.temp.toFixed(0)+'°':'idle','°C · keep under ~70',bx.temp>=68));
  gg.appendChild(gauge('Power',bx.power,0,30,bx.power==null?'–':bx.power.toFixed(1),'watts'));
  gg.appendChild(gauge('Efficiency',eff==null?null:Math.max(0,40-eff),0,30,eff==null?'–':eff.toFixed(1),'J/TH · lower is better'));
  [['Shares',fmt(bx.accepted)+' / '+fmt(bx.rejected),'accepted / rejected'],
   ['Best share ever',dif(bx.bestDiff),'difficulty'],
   ['Frequency',bx.frequency!=null?bx.frequency+' MHz':'–',bx.vrTemp!=null?'regulator '+bx.vrTemp.toFixed(0)+' °C':''],
   ['Fan',bx.fanRpm==null?'–':fmt(bx.fanRpm)+' rpm',bx.fanPct!=null?Math.round(bx.fanPct)+'% speed':''],
   ['Input voltage',bx.voltage==null?'–':(bx.voltage/1000).toFixed(2)+' V','power supply'],
   ['Uptime',dur(bx.uptime),bx.rssi!=null?'Wi-Fi '+bx.rssi+' dBm':'']
  ].forEach(function(r){g.appendChild(stat(r[0],r[1],r[2]))});
}
function renderShares(s){
  var box=$('sf'),a=s.shares||[],nd=s.latest&&s.latest.netDifficulty;box.textContent='';
  if(!a.length){box.appendChild(el('div','note','New personal-best shares will appear here.'));return}
  a.slice().reverse().slice(0,6).forEach(function(x){var r=el('div','r');
    r.appendChild(el('span',null,dif(x.diff)+' · '+ago(Math.max(0,s.now-x.t))));
    r.appendChild(el('span','note',nd?'1 / '+words(nd/x.v)+' of a block':''));box.appendChild(r)});
}
function renderOdds(l,s){
  var g=$('odds'),nt=$('oddsnote');g.textContent='';
  var bx=l.bitaxe,nd=l.netDifficulty;if(!nd){nt.textContent='Needs the network difficulty.';return}
  var hr=bx&&bx.online&&bx.hashrate>0?bx.hashrate:0,assumed=false;
  if(!hr){for(var i=s.history.length-1;i>=0;i--){if(s.history[i].hr>0){hr=s.history[i].hr;break}}}
  if(!hr){hr=1200;assumed=true}
  var netH=nd*4294967296/600,mine=hr*1e9,share=mine/netH,reward=50/Math.pow(2,Math.floor((l.headers||0)/210000));
  var secs=nd*4294967296/mine,sat=share*144*reward*1e8;
  [['My share of the network','1 in '+words(1/share),hnum(netH)+'H/s total'],['Time to a block',years(secs),'on average, solo'],
   ['Per day',(sat<10?sat.toFixed(1):Math.round(sat))+' sats','expected value'],['Block reward',reward+' BTC','plus fees']
  ].forEach(function(r){var d=el('div');d.appendChild(el('div','k',r[0]));d.appendChild(el('div','v',r[1]));d.lastChild.style.cssText='font-size:17px;font-weight:650';d.appendChild(el('div','note',r[2]));g.appendChild(d)});
  nt.textContent=(assumed?'Assumes 1.2 TH/s until the Bitaxe reports. ':'')+'A pool pays by shares, so real earnings are much smoother than solo odds.';
}

/* ---------- node (under the hood) ---------- */
function renderNode(st,s){
  var l=st.l,pct=st.pct,synced=st.synced;
  $('pct').textContent=pct==null?'–':(pct<99.99?pct.toFixed(2):'100')+'% synced';
  $('barfill').style.width=(pct||0)+'%';
  $('pdetail').textContent='block '+fmt(l.blocks)+' of '+fmt(l.headers);
  var left=(l.headers||0)-(l.blocks||0);
  $('pmore').textContent=synced?'At the chain tip.':'Validated up to '+dstr(l.tipTime)+' · '+fmt(left)+' blocks to go.';
  var sp=speed(s.history),last=sp.length?sp[sp.length-1][1]:null,g=$('stats');g.textContent='';
  [['Peers',fmt((l.peersIn||0)+(l.peersOut||0)),fmt(l.peersOut)+' out · '+fmt(l.peersIn)+' in'],
   ['Mempool',fmt(l.mempoolTx)+' tx',l.mempoolBytes!=null?(l.mempoolBytes/1e6).toFixed(1)+' MB':''],
   ['Latest block',synced&&l.tipTime?ago(Math.max(0,s.now-l.tipTime)):dstr(l.tipTime),synced?'since the last block':'date being validated'],
   ['Difficulty',hnum(l.netDifficulty||l.difficulty),'network'],
   ['Disk used',gb(l.sizeOnDisk),l.pruned?'pruned · keeps '+gb(l.pruneTarget):'full archive'],
   ['Oldest block kept',l.pruned?fmt(l.pruneHeight):'all',l.pruned?'older ones pruned':''],
   ['Node memory',l.resources&&l.resources.memBytes!=null?hb(l.resources.memBytes):'–',l.resources&&l.resources.cpuPct!=null?l.resources.cpuPct.toFixed(0)+'% CPU':''],
   ['Disk free',l.resources&&l.resources.diskFree!=null?hb(l.resources.diskFree):'–',l.resources&&l.resources.diskTotal!=null?'of '+hb(l.resources.diskTotal):''],
   ['Data transferred',l.bytesIn==null?'–':hb(l.bytesIn+l.bytesOut),l.bytesIn==null?'':hb(l.bytesIn)+' in · '+hb(l.bytesOut)+' out'],
   ['Peers by network',nets(l.networks),'connected now'],
   ['Uptime',dur(l.uptime),'node process'],
   ['Sync speed',last==null?'–':last.toFixed(last<10?1:0)+' /min','blocks, recent']
  ].forEach(function(r){g.appendChild(stat(r[0],r[1],r[2]))});
}
function renderFees(l){
  var g=$('fm'),nt=$('fmnote'),bx=$('fmb'),f=l.fees;g.textContent='';bx.textContent='';
  var est=f&&f.estimates||{},keys=Object.keys(est);
  nt.textContent=keys.length||(f&&f.buckets)?'What my node expects a transaction to pay, and how its mempool is spread across fee rates.':'Fee estimates appear once the node has watched the mempool for a while.';
  var lab={'1':'Next block','3':'Within 3 blocks','6':'Within 6 blocks','24':'Within 4 hours','144':'Within a day'};
  ['1','3','6','24','144'].forEach(function(k){if(est[k]!=null)g.appendChild(stat(lab[k],est[k].toFixed(1)+' sat/vB','estimated fee rate'))});
  if(!keys.length)dimmed(g,['Fee estimate'],'not ready yet');
  var b=f&&f.buckets;if(!b){bx.hidden=true;return}
  var tot=b.reduce(function(a,x){return a+x},0);bx.hidden=!tot;if(!tot)return;
  var names=['< 2','2-5','5-10','10-25','25-50','50-100','100+'],mx=Math.max.apply(null,b);
  bx.appendChild(el('div','k','Mempool by fee rate (sat/vB)'));
  b.forEach(function(v,i){var r=el('div');r.style.cssText='display:flex;align-items:center;gap:8px;font-size:12px;margin:5px 0';
    var a=el('span',null,names[i]);a.style.cssText='width:56px;color:var(--mute)';
    var bar=el('div','bar');bar.style.cssText='flex:1;margin:0;height:8px';var fi=el('i');fi.style.width=(v/mx*100)+'%';bar.appendChild(fi);
    var n=el('span',null,(v/1e6).toFixed(2)+' MvB');n.style.cssText='width:70px;text-align:right';
    r.appendChild(a);r.appendChild(bar);r.appendChild(n);bx.appendChild(r)});
}
function renderBlocks(l,s){
  var g=$('rb'),nt=$('rbnote'),r=l.recent||[];g.textContent='';
  if(!r.length){nt.textContent='The last few blocks appear here once the node is synced.';dimmed(g,['Latest block'],'after sync');return}
  nt.textContent='Newest first. The pool name comes from the tag in each block\'s coinbase.';
  r.forEach(function(x){var c=el('div','card stat');c.appendChild(el('div','k','Block '+fmt(x.height)+' · '+ago(Math.max(0,s.now-x.time))));
    c.appendChild(el('div','v',x.pool||'unknown pool'));
    [['Transactions',fmt(x.txs)],['Full',x.weight==null?'–':(x.weight/40000).toFixed(1)+'%'],['Fees',x.fees==null?'–':(x.fees/1e8).toFixed(3)+' BTC'],['Avg fee rate',x.feeRate==null?'–':x.feeRate+' sat/vB']].forEach(function(q){c.appendChild(el('div','s',q[0]+': '+q[1]))});
    g.appendChild(c)});
}

/* ---------- charts ---------- */
function chart(host,pts,opt){
  host.textContent='';
  if(!pts||pts.length<2){host.appendChild(el('div','empty','collecting data…'));return}
  var W=600,H=170,L=50,R=8,T=8,B=22,col=opt.color||'var(--accent)';
  var x0=pts[0][0],x1=pts[pts.length-1][0],lo=Infinity,hi=-Infinity;
  pts.forEach(function(p){if(p[1]<lo)lo=p[1];if(p[1]>hi)hi=p[1]});
  if(opt.zero)lo=Math.min(lo,0);if(hi===lo)hi=lo+1;
  var sx=function(t){return L+(t-x0)/Math.max(1,x1-x0)*(W-L-R)},sy=function(v){return T+(1-(v-lo)/(hi-lo))*(H-T-B)};
  var d=pts.map(function(p,i){return(i?'L':'M')+sx(p[0]).toFixed(1)+' '+sy(p[1]).toFixed(1)}).join('');
  var svg=sv('svg',{viewBox:'0 0 '+W+' '+H});
  [0,.5,1].forEach(function(f){var y=T+f*(H-T-B);svg.appendChild(sv('line',{x1:L,x2:W-R,y1:y,y2:y,style:'stroke:var(--line)'}));
    svg.appendChild(sv('text',{x:L-6,y:y+3,'text-anchor':'end','class':'ax'},opt.fmt(hi-(hi-lo)*f)))});
  svg.appendChild(sv('path',{d:d+'L'+sx(x1).toFixed(1)+' '+(H-B)+'L'+sx(x0).toFixed(1)+' '+(H-B)+'Z',style:'fill:'+col,opacity:'.12'}));
  svg.appendChild(sv('path',{d:d,fill:'none',style:'stroke:'+col,'stroke-width':2,'stroke-linejoin':'round'}));
  var tl=function(t){var dt=new Date(t*1000);return (x1-x0>172800)?dt.toISOString().slice(5,10):dt.toISOString().slice(11,16)+'Z'};
  svg.appendChild(sv('text',{x:L,y:H-6,'class':'ax'},tl(x0)));
  svg.appendChild(sv('text',{x:W-R,y:H-6,'text-anchor':'end','class':'ax'},tl(x1)));
  host.appendChild(svg)}
function speed(h){var out=[],i,j;for(i=1;i<h.length;i++){j=i;while(j>0&&h[i].t-h[j-1].t<=600)j--;
  var dt=h[i].t-h[j].t;if(dt<120||h[i].blocks==null||h[j].blocks==null)continue;out.push([h[i].t,(h[i].blocks-h[j].blocks)/dt*60])}return out}
function series(h,k,since){return h.filter(function(p){return p[k]!=null&&(!since||p.t>=since)}).map(function(p){return[p.t,p[k]]})}

function render(s){
  LAST=s;var l=s.latest;
  if(!l){$('meta').textContent='no data yet';$('statustxt').textContent='waiting';return}
  var st=derive(s),pill=$('status'),txt;
  if(st.stale){txt='Offline';pill.className='pill bad'}
  else if(st.hashing&&st.decl){txt='Mining';pill.className='pill ok'}
  else if(!st.synced){txt='Node syncing';pill.className='pill sync'}
  else if(!st.sv.client||!st.sv.tp){txt='Stack down';pill.className='pill bad'}
  else{txt='Starting';pill.className='pill sync'}
  $('statustxt').textContent=txt;
  $('meta').textContent='Bitcoin Core '+(l.version||'').replace(/^Satoshi:/,'v')+' · sv2-tp · DMND client · Bitaxe Gamma · updated '+ago(st.age);
  renderStory(st);renderDiagram(st);renderKpis(st,s);renderBlock(st);renderClient(st);renderBitaxe(st);
  renderVs(s);renderPolicy(l);renderMix(l);renderShares(s);renderOdds(l,s);renderNode(st,s);renderFees(l);renderBlocks(l,s);
  var h=s.history,day=s.now-86400;
  chart($('c7'),series(h,'tf',day).map(function(p){return[p[0],p[1]/1e6]}),{fmt:function(v){return v.toFixed(2)}});
  chart($('c9'),series(h,'ad',day),{fmt:function(v){return fmt(Math.round(v))},zero:true});
  chart($('c10'),series(h,'dl',day),{fmt:function(v){return v.toFixed(0)},zero:true});
  chart($('c8'),series(h,'sh',day),{fmt:function(v){return fmt(Math.round(v))},zero:true,color:'var(--hash)'});
  chart($('c5'),series(h,'hr',day),{fmt:function(v){return v.toFixed(0)},zero:true,color:'var(--hash)'});
  chart($('c6'),h.filter(function(p){return p.temp!=null&&p.temp>0&&p.t>=day}).map(function(p){return[p.t,p.temp]}),{fmt:function(v){return v.toFixed(0)},color:'var(--hash)'});
  chart($('c1'),series(h,'blocks'),{fmt:function(v){return fmt(Math.round(v))}});
  chart($('c2'),speed(h),{fmt:function(v){return v.toFixed(0)},zero:true});
  chart($('c3'),series(h,'peers'),{fmt:function(v){return v.toFixed(0)},zero:true});
  chart($('c4'),series(h,'disk').map(function(p){return[p[0],p[1]/1e9]}),{fmt:function(v){return v.toFixed(1)}});
  var ps=s.poolStart,pp=Math.max(0,Math.min(100,((l.blocks||0)/ps)*100));
  if(l.blocks>=ps){$('poolpct').textContent='Window reached';$('poolbar').style.width='100%';$('pooltxt').textContent='Block data from '+fmt(ps)+' onward is on the node.'}
  else{$('poolpct').textContent=pp.toFixed(1)+'% to window start';$('poolbar').style.width=pp+'%';$('pooltxt').textContent='The review window begins at block '+fmt(ps)+'.'}
}
function load(){fetch('/api/stats').then(function(r){return r.json()}).then(render).catch(function(){$('meta').textContent='could not load stats'})}
function tab(n){['status','pools'].forEach(function(k){$('p-'+k).hidden=k!==n;$('t-'+k).setAttribute('aria-selected',k===n)})}
$('t-status').onclick=function(){tab('status')};$('t-pools').onclick=function(){tab('pools')};
var rt=null;window.addEventListener('resize',function(){clearTimeout(rt);rt=setTimeout(function(){if(LAST&&LAST.latest)renderDiagram(derive(LAST))},150)});
load();setInterval(load,30000);
})();
</script></body></html>`;
