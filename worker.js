// Bitcoin node dashboard — Cloudflare Worker (module syntax).
//   GET  /             dashboard page
//   GET  /api/stats    latest snapshot + history (public, aggregate stats only)
//   POST /api/push     collector writes a snapshot (Bearer WRITE_KEY)
// State lives in one KV key ("state") so each push costs a single KV write.

const MAX_POINTS = 4000;

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

function sanitizeMs(m) {
  if (!m || typeof m !== "object") return null;
  const n = m.next && typeof m.next === "object"
    ? { tx: num(m.next.tx), fees: num(m.next.fees), vsize: num(m.next.vsize), median: num(m.next.median),
        avg: num(m.next.avg), backlog: num(m.next.backlog) } : null;
  const a = m.acc && typeof m.acc === "object" ? m.acc : {};
  const mined = {};
  if (a.minedBy && typeof a.minedBy === "object") {
    for (const [k, v] of Object.entries(a.minedBy)) {
      if (Object.keys(mined).length >= 6) break;
      if (/^[A-Za-z0-9 ._-]{1,32}$/.test(k) && num(v) !== null) mined[k] = v;
    }
  }
  return {
    next: n, rec: numMap(m.rec, 6),
    acc: { active: num(a.active), done: num(a.done), feeDelta: num(a.feeDelta), bid: num(a.bid),
           span: num(a.span), pools: num(a.pools), minedBy: mined },
  };
}

function sanitizeRsk(r) {
  if (!r || typeof r !== "object" || r.online !== true) return null;
  const m = r.mm && typeof r.mm === "object" ? r.mm : null;
  return {
    online: true, block: num(r.block), bridge: bool(r.bridge), synced: bool(r.synced),
    peers: num(r.peers), tipAge: num(r.tipAge), dbBytes: num(r.dbBytes),
    mm: m ? { configured: bool(m.configured), work: bool(m.work), found: num(m.found), pending: num(m.pending) } : null,
  };
}

function sanitizeBh(b) {
  if (!b || typeof b !== "object" || num(b.height) === null) return null;
  return {
    height: num(b.height), mode: b.mode === "live" ? "live" : "dry", open: bool(b.open),
    votes: num(b.votes), picked: num(b.picked), score: num(b.score), gate: bool(b.gate),
    age: num(b.age), rounds: num(b.rounds),
  };
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
    ms: sanitizeMs(body.ms),
    rsk: sanitizeRsk(body.rsk),
    bh: sanitizeBh(body.bh),
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
  return new Response(JSON.stringify({ ...state, now: Math.floor(Date.now() / 1000) }), {
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
nav{display:flex;gap:6px;margin:0 0 16px;overflow-x:auto;-webkit-overflow-scrolling:touch}
nav button{white-space:nowrap;flex:none}
nav .navlink{white-space:nowrap;flex:none;margin-left:auto;padding:6px 14px;border-radius:8px;border:1px solid var(--accent);color:var(--accent);text-decoration:none;font-weight:650}
nav .navlink+.navlink{margin-left:0}
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
.dg .ll{font-size:11px;fill:var(--mute);font-weight:600}.dg .ll.lv{font-weight:500;fill:var(--ink)}
.dg g.tap{cursor:pointer;outline:none}.dg g.tap:hover .bx,.dg g.tap:focus-visible .bx,.dg g.tap.sel .bx{stroke:var(--accent);stroke-width:2}
.dg .bx.flash{animation:flashbx 1.4s ease-out 3}
@keyframes flashbx{0%{stroke:var(--accent);stroke-width:7;fill:var(--accent-soft)}100%{stroke-width:1.5}}
.dg .pk{fill:var(--accent)}.dg .pk.hs{fill:var(--hash)}
.dg .spl{stroke:var(--accent);stroke-width:1.6;stroke-linejoin:round;stroke-linecap:round}
.sp{width:100%;height:46px;color:var(--accent)}.sp .spl{stroke:currentColor}.sp.big{height:46px;margin-top:8px}
.dgcard{border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:0 0 10px;background:var(--card)}
.dch{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.dcx{font:inherit;font-size:12px;border:1px solid var(--line);background:none;color:var(--mute);border-radius:8px;padding:2px 10px;cursor:pointer}
.dcg{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:4px 18px;font-size:13px}
.dcg div{display:flex;justify-content:space-between;gap:10px;border-bottom:1px solid var(--line);padding:3px 0}
.dcg .k{color:var(--mute)}.dcg .v{font-weight:650;text-align:right}
.tick{margin-top:8px;font-size:13px;color:var(--mute);font-variant-numeric:tabular-nums}
.toast{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);background:var(--ink);color:var(--bg);padding:8px 16px;border-radius:99px;font-size:13px;z-index:9;max-width:90vw;box-shadow:0 4px 18px rgba(0,0,0,.25)}
@keyframes flow{to{stroke-dashoffset:-16}}
@media (prefers-reduced-motion:reduce){.dg .lk.live,.pill.ok i,.dg .bx.flash{animation:none}}
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
  <button role="tab" id="t-over" aria-selected="true">Overview</button>
  <button role="tab" id="t-block" aria-selected="false">My block</button>
  <button role="tab" id="t-miner" aria-selected="false">Miner</button>
  <button role="tab" id="t-nodes" aria-selected="false">Nodes</button>
  <a class="navlink" href="https://block-hunter.alejandro-d92.workers.dev/" target="_blank" rel="noopener">Create your own block &#8599;</a>
  <a class="navlink" href="https://github.com/AlejandroDeLaTorre/DMNDsv2Solo" target="_blank" rel="noopener">Build your own &rarr;</a>
</nav>

<section id="p-over">
  <div class="card hero">
    <p class="story" id="story">loading&hellip;</p>
    <div id="diagram"></div>
    <div class="dgcard" id="dgcard" hidden></div>
    <div class="legend">
      <span class="lt"><b></b>Block templates and job declaration (Stratum V2)</span>
      <span class="lh"><b></b>Hashes and shares</span>
      <span>Moving lines and dots are live, the dot pace is illustrative. Tap a box for details.</span>
    </div>
    <div class="tick" id="tick" hidden></div>
  </div>
  <div class="kpis" id="kpis"></div>

  <h2 class="sec">Also mining RSK <span class="tag t">Merge mining</span></h2>
  <p class="lead" id="rsknote"></p>
  <div class="grid" id="rsk"></div>
</section>

<section id="p-block" hidden>
  <h2 class="sec">The block I&rsquo;m mining <span class="tag t">Job Declaration</span></h2>
  <p class="lead" id="tpnote"></p>
  <div class="two" id="blockviz"></div>
  <div class="charts">
    <div class="card chart"><h3>Fees in the declared block (million sats)</h3><div id="c7"></div></div>
    <div class="card chart"><h3>Templates declared to the pool</h3><div id="c9"></div></div>
  </div>
  <h2 class="sec">Prioritised transactions <span class="tag t">My choice</span></h2>
  <p class="lead" id="prnote"></p>
  <div class="grid" id="prg"></div>

  <h2 class="sec">My template vs the block that was mined</h2>
  <p class="lead" id="vsnote"></p>
  <div class="kpis" id="vsk"></div>
  <div class="card" id="vs"></div>
</section>

<section id="p-miner" hidden>
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
</section>

<section id="p-nodes" hidden>
  <h2 class="sec">Bitcoin node <span class="tag n">Bitcoin Core</span></h2>
  <p class="lead">Bitcoin Core in multiprocess mode, pruned, feeding sv2-tp over IPC.</p>
  <div class="card prog">
    <div class="row"><span class="big" id="pct">&ndash;</span><span class="sub" id="pdetail"></span></div>
    <div class="bar"><i id="barfill"></i></div>
    <div class="sub" id="pmore"></div>
  </div>
  <div class="grid" id="stats"></div>
  <div class="charts">
    <div class="card chart"><h3>Blocks validated</h3><div id="c1"></div></div>
    <div class="card chart"><h3>Sync speed (blocks/min)</h3><div id="c2"></div></div>
    <div class="card chart"><h3>Connected peers</h3><div id="c3"></div></div>
    <div class="card chart"><h3>Disk used (GB)</h3><div id="c4"></div></div>
  </div>
</section>

<div class="toast" id="toast" hidden></div>
<footer>Aggregate statistics only: no transactions, addresses, wallet or machine details are published. Updates about every 2 minutes.<br><a href="https://github.com/AlejandroDeLaTorre/DMNDsv2Solo" target="_blank" rel="noopener">Step-by-step guide</a> &middot; <a href="https://new-platform.dmnd.work/signup" target="_blank" rel="noopener">Sign up with DMND</a></footer>
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
         shares:!stale&&hashing&&sv0.miners>0,jobs:!stale&&sv0.miners>0&&!!decl,bh:!stale&&!!(l.bh&&l.bh.age<900),
         rsk:!stale&&!!(l.rsk&&l.rsk.synced),bridge:!stale&&!!(l.rsk&&l.rsk.bridge&&l.rsk.mm&&l.rsk.mm.work),ms:!stale&&!!(l.ms&&l.ms.next)};
  var dead={bh:!l.bh,rsk:!l.rsk,bridge:!(l.rsk&&l.rsk.bridge),ms:!l.ms,ipc:!sv0.ipc,tpl:!sv0.tp,decl:!sv0.client,shares:!sv0.client||(bx&&!bx.online),jobs:!sv0.client};
  return {l:l,age:age,stale:stale,synced:synced,pct:l.progress==null?null:l.progress*100,sv:sv0,bx:bx,d:d,t:t,decl:decl,hashing:hashing,lat:lat,k:k,dead:dead};
}

/* ---------- live SV2 diagram ---------- */
var WIDE={W:980,H:336,bw:180,bh:88,
  n:{node:[10,40],tp:[270,40],client:[530,40],pool:[790,40],bitaxe:[530,210],rskj:[10,210],bridge:[270,210],ms:[790,210]},
  regions:[[0,8,722,136],[0,176,462,136]],labels:[[14,28,'start','THIS LAPTOP'],[790,28,'start','INTERNET'],[14,196,'start','THIS LAPTOP, RSK MERGE MINING'],[790,198,'start','INTERNET'],[530,320,'start','HOME NETWORK']],
  links:[['ipc','tp','M190 84 L270 84',[230,76,'middle'],'IPC',-12],
         ['tpl','tp','M450 84 L530 84',[490,76,'middle'],'Templates',-12],
         ['decl','tp','M710 72 L790 72',[750,62,'middle'],'Declare jobs',-12],
         ['shares','hs','M710 100 L790 100',[750,118,'middle'],'Shares',null],
         ['shares','hs','M600 210 L600 128',[592,174,'end'],'Shares',12],
         ['jobs','tp','M640 128 L640 210',[648,174,'start'],'Jobs',0],
         ['rsk','tp','M190 254 L270 254',[230,246,'middle'],'RPC',0],
         ['bridge','tp','M450 236 L500 236 L500 150 L560 150 L560 128',[492,200,'end'],'RSK work',0],
         ['ms','tp','M790 244 L750 244 L750 118 L710 118',[742,190,'end'],'Boosts',-12]]};
var TALL={W:360,H:1140,bw:220,bh:84,
  n:{node:[120,36],tp:[120,176],client:[120,316],pool:[120,476],bitaxe:[120,606],rskj:[120,760],bridge:[120,900],ms:[120,1040]},
  regions:[[100,8,252,400],[100,732,252,264]],labels:[[112,26,'start','THIS LAPTOP'],[120,468,'start','INTERNET'],[120,598,'start','HOME NETWORK'],[112,750,'start','THIS LAPTOP, RSK'],[120,1032,'start','INTERNET']],
  links:[['ipc','tp','M230 120 L230 176',[238,152,'start'],'IPC',0],
         ['tpl','tp','M230 260 L230 316',[238,292,'start'],'Templates',12],
         ['decl','tp','M205 400 L205 476',[197,442,'end'],'Declare jobs',-12],
         ['shares','hs','M255 400 L255 476',[263,442,'start'],'Shares',null],
         ['shares','hs','M120 660 L40 660 L40 344 L120 344',[30,500,'rot'],'Shares',0],
         ['jobs','tp','M120 372 L70 372 L70 632 L120 632',[84,500,'rot'],'Jobs',0],
         ['rsk','tp','M230 844 L230 900',[238,876,'start'],'RPC',0],
         ['bridge','tp','M340 942 L354 942 L354 372 L340 372',[348,660,'rot'],'RSK work',0],
         ['ms','tp','M120 1082 L12 1082 L12 328 L120 328',[20,1074,'start'],'Boosts',-12]]};
/* Block Hunter sits above the Bitcoin node: shift the existing layout down and add its box. */
function shiftLayout(L,dy){
  L.H+=dy;
  Object.keys(L.n).forEach(function(k){L.n[k][1]+=dy});
  L.regions.forEach(function(r){r[1]+=dy});
  L.labels.forEach(function(q){q[1]+=dy});
  L.links.forEach(function(k){
    k[2]=k[2].replace(/([ML])(-?[0-9.]+) (-?[0-9.]+)/g,function(m,c,x,y){return c+x+' '+(parseFloat(y)+dy)});
    k[3][1]+=dy;
  });
}
shiftLayout(WIDE,130);shiftLayout(TALL,140);
WIDE.n.bh=[10,40,204];WIDE.labels.push([10,28,'start','INTERNET']);
WIDE.links.push(['bh','tp','M100 128 L100 170',[108,154,'start'],'Crowd picks',0]);
TALL.n.bh=[120,36];TALL.labels.push([120,28,'start','INTERNET']);
TALL.links.push(['bh','tp','M230 120 L230 176',[238,152,'start'],'Crowd picks',0]);
var PREV=null,FLASH={},SEL=null,TICK=null,REDUCE=false;
try{REDUCE=window.matchMedia('(prefers-reduced-motion: reduce)').matches}catch(e){}
function clamp(v,a,b){return Math.max(a,Math.min(b,v))}
function shareInterval(h){
  var n=h.length-1;while(n>=0&&h[n].sh==null)n--;if(n<1)return null;
  var j=n;while(j>0&&h[j-1].sh!=null&&h[j-1].sh<=h[j].sh&&h[n].t-h[j-1].t<=3600)j--;
  var dn=h[n].sh-h[j].sh,dt=h[n].t-h[j].t;return dn>0&&dt>=120?dt/dn:null;
}
function spark(pts,w,h){
  var svg=sv('svg',{viewBox:'0 0 '+w+' '+h,'class':'sp'});
  if(!pts||pts.length<2)return svg;
  var x0=pts[0][0],x1=pts[pts.length-1][0],lo=Infinity,hi=-Infinity;
  pts.forEach(function(p){if(p[1]<lo)lo=p[1];if(p[1]>hi)hi=p[1]});if(hi===lo){hi=lo+1}
  var d=pts.map(function(p,i){return(i?'L':'M')+(2+(p[0]-x0)/Math.max(1,x1-x0)*(w-4)).toFixed(1)+' '+(2+(1-(p[1]-lo)/(hi-lo))*(h-4)).toFixed(1)}).join('');
  svg.appendChild(sv('path',{d:d,fill:'none','class':'spl'}));return svg;
}
function sparkPath(pts,x,y,w,h){
  if(!pts||pts.length<2)return null;
  var x0=pts[0][0],x1=pts[pts.length-1][0],lo=Infinity,hi=-Infinity;
  pts.forEach(function(p){if(p[1]<lo)lo=p[1];if(p[1]>hi)hi=p[1]});if(hi===lo){hi=lo+1}
  return pts.map(function(p,i){return(i?'L':'M')+(x+(p[0]-x0)/Math.max(1,x1-x0)*w).toFixed(1)+' '+(y+(1-(p[1]-lo)/(hi-lo))*h).toFixed(1)}).join('');
}
function renderDiagram(st){
  var host=$('diagram'),hw=host.clientWidth;
  var visible=hw>0;
  var L=hw>=680?WIDE:TALL,svg=sv('svg',{viewBox:'0 0 '+L.W+' '+L.H,'class':'dg',role:'group','aria-label':'Live diagram of the Stratum V2 mining stack. Select a box for details.'});
  L.regions.forEach(function(r){svg.appendChild(sv('rect',{x:r[0],y:r[1],width:r[2],height:r[3],rx:16,'class':'rg'}))});
  L.labels.forEach(function(q){svg.appendChild(sv('text',{x:q[0],y:q[1],'text-anchor':q[2],'class':'rl'},q[3]))});
  var l=st.l,sv0=st.sv,bx=st.bx,d=st.d,w=L.bw,h=L.bh,ml=w>200?19:16,sl=w>200?31:25,hist=LAST&&LAST.history||[];
  var iv=declInterval(hist),shiv=shareInterval(hist),day=LAST?LAST.now-86400:0;
  var pace={ipc:iv,tpl:iv,decl:iv,jobs:iv,shares:shiv,rsk:30,bridge:iv,ms:30};
  var VAL={tpl:iv!=null?'every ~'+Math.round(iv)+' s':null,decl:st.lat!=null?Math.round(st.lat)+' ms':null,
    shares:bx&&bx.online&&bx.hashrate?hrate(bx.hashrate):null,ms:'30 s poll'};
  var live=[];
  L.links.forEach(function(k){
    var state=st.stale?'dead':st.k[k[0]]?'live':st.dead[k[0]]?'dead':'';
    svg.appendChild(sv('path',{d:k[2],'class':'lk '+k[1]+' '+state}));
    if(state==='live')live.push(k);
  });
  L.links.forEach(function(k){var p=k[3],v=VAL[k[0]],a={x:p[0],y:p[1],'class':'ll','text-anchor':p[2]==='rot'?'middle':p[2]};
    if(p[2]==='rot'){a.transform='rotate(-90 '+p[0]+' '+p[1]+')';svg.appendChild(sv('text',a,k[4]+(v?' · '+v:'')));return}
    svg.appendChild(sv('text',a,k[4]));
    if(v&&k[5]!==null){var b={x:p[0],y:p[1]+(k[5]||12),'class':'ll lv','text-anchor':p[2]};svg.appendChild(sv('text',b,v))}});
  if(!REDUCE)live.forEach(function(k,i){
    var sp=clamp(pace[k[0]]!=null?pace[k[0]]:8,3,14),tr=2.4,f=Math.min(1,tr/sp);
    var c=sv('circle',{r:3.6,'class':'pk '+k[1],opacity:0});
    var m=sv('animateMotion',{path:k[2],dur:sp+'s',repeatCount:'indefinite',keyPoints:'0;1;1',keyTimes:'0;'+f.toFixed(3)+';1',calcMode:'linear',begin:(-(i*1.3%sp)).toFixed(2)+'s'});
    var o=sv('animate',{attributeName:'opacity',dur:sp+'s',repeatCount:'indefinite',values:'1;1;0;0',keyTimes:'0;'+Math.max(0.001,f-0.002).toFixed(3)+';'+f.toFixed(3)+';1',begin:(-(i*1.3%sp)).toFixed(2)+'s'});
    c.appendChild(m);c.appendChild(o);svg.appendChild(c)});
  function box(key,title,on,main,sub,hl,spk){var p=L.n[key];if(!p)return;var x=p[0],y=p[1],bw=p[2]||w,g=sv('g',{'class':'tap'+(SEL===key?' sel':''),tabindex:0,role:'button','aria-label':title+': '+main});
    g.appendChild(sv('rect',{x:x,y:y,width:bw,height:h,rx:12,'class':'bx'+(hl?' hl':'')+(visible&&FLASH[key]?' flash':'')}));
    g.appendChild(sv('circle',{cx:x+bw-16,cy:y+20,r:5,'class':'dt '+(on===true?'on':on===false?'off':'')}));
    g.appendChild(sv('text',{x:x+14,y:y+25,'class':'t'},title));
    g.appendChild(sv('text',{x:x+14,y:y+53,'class':'m'},clip(main,ml)));
    if(sub)g.appendChild(sv('text',{x:x+14,y:y+74,'class':'s'},clip(sub,sl)));
    var sd=sparkPath(spk,x+w-68,y+34,52,18);if(sd)g.appendChild(sv('path',{d:sd,fill:'none','class':'spl'}));
    var go=function(){SEL=SEL===key?null:key;renderDiagram(derive(LAST));renderDgCard()};
    g.onclick=go;g.onkeydown=function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();go()}};
    svg.appendChild(g)}
  var bh=l.bh;
  box('bh','Create your own block',bh?bh.age<900:null,bh?(bh.open?'Voting open':bh.picked?'Slice locked':'No votes'):'Offline',bh?'Round '+fmt(bh.height)+' · '+(bh.mode==='live'?'LIVE':'practice'):'optional game');
  var ver=(l.version||'').replace(/^Satoshi:/,'v');
  box('node','Bitcoin node',!st.stale,st.synced?'Block '+fmt(l.blocks):(st.pct==null?'–':st.pct.toFixed(1)+'% synced'),'Core '+ver+' · '+fmt((l.peersIn||0)+(l.peersOut||0))+' peers');
  box('tp','sv2-tp',st.stale?false:!!sv0.tp,!sv0.tp?'Down':st.synced?(st.t.length?'Building blocks':'Serving'):'Waiting for sync','Template Provider · '+dur(sv0.tpUptime));
  box('client','DMND client',st.stale?false:!!sv0.client,!sv0.client?'Down':st.decl?(d.activeId!=null?'Template #'+fmt(d.activeId):'Declaring'):'Connecting',fmt(sv0.miners)+' miner'+(sv0.miners===1?'':'s')+' · up '+dur(sv0.clientUptime),!!st.decl);
  box('pool','DMND pool',st.k.decl?true:null,st.lat!=null?Math.round(st.lat)+' ms':st.k.decl?'Accepting':'–',st.lat!=null?'declaration latency':'external pool',false,series(hist,'dl',day));
  box('bitaxe','Bitaxe Gamma',bx?bx.online:null,bx&&bx.online?hrate(bx.hashrate):bx?'Offline':'–',bx&&bx.online?(bx.temp>0?bx.temp.toFixed(0)+' °C':'idle')+' · '+(bx.power!=null?bx.power.toFixed(1)+' W':'–'):'',false,series(hist,'hr',day));
  var rs=l.rsk,ms=l.ms,mact=ms&&ms.acc&&ms.acc.active!=null?fmt(ms.acc.active)+(ms.acc.active===1?' boost':' boosts'):ms&&ms.next?'Connected':'–';
  box('rskj','RSK node',rs?!!rs.synced:null,rs?'Block '+fmt(rs.block):'Not reporting',rs?'Rootstock · '+fmt(rs.peers)+' peers':'optional');
  box('bridge','RSK bridge',rs&&rs.bridge!=null?rs.bridge:null,rs&&rs.bridge?(rs.mm&&rs.mm.work?'Sending work':'Waiting'):'Stopped','merge mining');
  box('ms','mempool.space',ms?true:null,mact,'public fee-boost feed');
  if(L===TALL)svg.style.maxWidth='400px',svg.style.margin='0 auto';
  host.textContent='';host.appendChild(svg);
  if(visible)FLASH={};
}
/* ---------- tap a box: detail card ---------- */
function renderDgCard(){
  var c=$('dgcard');c.textContent='';
  if(!SEL||!LAST||!LAST.latest){c.hidden=true;return}
  var st=derive(LAST),l=st.l,bx=st.bx,d=st.d,sv0=st.sv,rs=l.rsk,ms=l.ms,h=LAST.history,day=LAST.now-86400,rows=[],title='',pts=null,col='var(--accent)',unit='';
  function R(k,v){rows.push([k,v==null?'–':v])}
  if(SEL==='node'){title='Bitcoin node';R('Version',(l.version||'').replace(/^Satoshi:/,'v'));R('Block height',fmt(l.blocks));R('Peers',fmt((l.peersIn||0)+(l.peersOut||0))+' ('+fmt(l.peersIn)+' in, '+fmt(l.peersOut)+' out)');R('Mempool',fmt(l.mempoolTx)+' transactions');R('Uptime',dur(l.uptime));R('Chain data on disk',gb(l.sizeOnDisk));pts=series(h,'peers',day);unit='peers, last 24 h'}
  else if(SEL==='tp'){title='sv2-tp (Template Provider)';R('Status',sv0.tp?'running':'down');R('Uptime',dur(sv0.tpUptime));R('Talks to Bitcoin Core over','IPC (unix socket)');R('Hands templates to','the DMND client')}
  else if(SEL==='client'){title='DMND client';R('Status',sv0.client?'running':'down');R('Uptime',dur(sv0.clientUptime));R('Miners connected',fmt(sv0.miners));R('Template',d&&d.activeId!=null?'#'+fmt(d.activeId):null);R('Coinbase tag',d&&d.tag);R('Template cadence',declInterval(h)?'a new one every ~'+Math.round(declInterval(h))+' s':null);pts=series(h,'ad',day);unit='templates declared, last 24 h (resets on restart)'}
  else if(SEL==='pool'){title='DMND pool';R('Declaration latency',st.lat!=null?Math.round(st.lat)+' ms':null);R('Bandwidth',d&&d.pool&&d.pool.bandwidth_bytes_per_sec!=null?hb(d.pool.bandwidth_bytes_per_sec)+'/s':null);R('Who picks the transactions','my node, not the pool');R('Does this delay a block?','No: a block I find goes straight to my own node and the network. This number only shows how fast the pool answers.');pts=series(h,'dl',day);unit='declaration latency (ms), last 24 h'}
  else if(SEL==='bitaxe'){title='Bitaxe Gamma';col='var(--hash)';if(bx&&bx.online){R('Hashrate',hrate(bx.hashrate));R('ASIC temperature',bx.temp!=null?bx.temp.toFixed(0)+' °C':null);R('Power',bx.power!=null?bx.power.toFixed(1)+' W':null);R('Frequency',bx.frequency!=null?bx.frequency+' MHz':null);R('Voltage',bx.voltage!=null?Math.round(bx.voltage)+' mV':null);R('Shares',fmt(bx.accepted)+' accepted, '+fmt(bx.rejected)+' rejected');R('Best share',bx.bestDiff);R('Uptime',dur(bx.uptime))}else R('Status','offline or not monitored');pts=series(h,'hr',day);unit='hashrate (GH/s), last 24 h'}
  else if(SEL==='rskj'){title='RSK node (RskJ)';if(rs){R('Status',rs.synced?'synced':'syncing');R('Block',fmt(rs.block));R('Latest block',rs.tipAge!=null?ago(rs.tipAge):null);R('Peers',fmt(rs.peers));R('Database',rs.dbBytes!=null?gb(rs.dbBytes):null)}else R('Status','not reporting')}
  else if(SEL==='bridge'){title='RSK bridge';var mm=rs&&rs.mm||{};R('Service',rs&&rs.bridge==null?null:rs&&rs.bridge?'running':'stopped');R('Merge mining',mm.configured==null?null:mm.configured?'on':'off');R('Work for the miner',mm.work==null?null:mm.work?'yes':'no');R('RSK blocks found',fmt(mm.found));R('Job','turns an RSK block into a commitment in my coinbase')}
  else if(SEL==='bh'){title='Create your own block (crowd vote)';R('Play it','block-hunter.alejandro-d92.workers.dev');var g2=l.bh;if(g2){R('Mode',g2.mode==='live'?'live: the winning slice is applied to my node':'practice only');R('Round',fmt(g2.height));R('Voting',g2.open?'open':'closed');R('Votes cast',fmt(g2.votes));R('Bundles in the crew block',fmt(g2.picked));R('Crew score',g2.score==null||!g2.picked?null:(g2.score*100).toFixed(1)+'% of best');R('Gate',g2.gate==null?null:g2.gate?'passed':'failed');R('Finished rounds',fmt(g2.rounds))}else R('Status','not reporting')}
  else if(SEL==='ms'){title='mempool.space';var n=ms&&ms.next,a=ms&&ms.acc||{};R('Projected next block',n?fmt(Math.round(n.fees))+' sats, '+fmt(n.tx)+' transactions':null);R('Fastest fee tier',ms&&ms.rec&&ms.rec.fastestFee!=null?ms.rec.fastestFee+' sat/vB':null);R('Active accelerations',a.active==null?null:fmt(a.active));R('Completed lately',a.done==null?null:fmt(a.done));R('Polled by the client','every 30 s')}
  var hd=el('div','dch');hd.appendChild(el('b',null,title));var x=el('button','dcx','Close');x.onclick=function(){SEL=null;renderDiagram(derive(LAST));renderDgCard()};hd.appendChild(x);c.appendChild(hd);
  var gr=el('div','dcg');rows.forEach(function(r){var q=el('div');q.appendChild(el('span','k',r[0]));q.appendChild(el('span','v',String(r[1])));gr.appendChild(q)});c.appendChild(gr);
  if(pts&&pts.length>1){var sp=spark(pts,300,46);sp.setAttribute('class','sp big');sp.style.color=col;c.appendChild(sp);c.appendChild(el('div','note',unit))}
  c.hidden=false;
}
/* ---------- events, toasts, hash counter ---------- */
var TT=null;
function toast(msg){var t=$('toast');t.textContent=msg;t.hidden=false;clearTimeout(TT);TT=setTimeout(function(){t.hidden=true},6000)}
function detectEvents(l,bx){
  var cur={b:l.blocks,a:l.dmnd&&l.dmnd.activeId,s:bx&&bx.online?bx.accepted:null,r:l.rsk?l.rsk.block:null},msg=[];
  if(PREV){
    if(cur.b!=null&&PREV.b!=null&&cur.b>PREV.b){FLASH.node=1;msg.push('New Bitcoin block '+fmt(cur.b))}
    if(cur.a!=null&&PREV.a!=null&&cur.a!==PREV.a)FLASH.client=1;
    if(cur.s!=null&&PREV.s!=null&&cur.s>PREV.s){FLASH.bitaxe=1;msg.push('Bitaxe: +'+(cur.s-PREV.s)+' share'+(cur.s-PREV.s===1?'':'s')+' accepted')}
    if(cur.r!=null&&PREV.r!=null&&cur.r>PREV.r)FLASH.rskj=1;
  }
  PREV=cur;if(msg.length)toast(msg.join(' · '));
}
function hashesTried(s,st){
  var up=st.sv&&st.sv.clientUptime;if(up==null||!st.bx||!st.bx.online)return null;
  var since=s.now-up,h=s.history.filter(function(p){return p.hr!=null&&p.t>=since}),tot=0,i;
  for(i=1;i<h.length;i++){var dt=h[i].t-h[i-1].t;if(dt>0&&dt<=1800)tot+=dt*(h[i].hr+h[i-1].hr)/2*1e9}
  var last=h.length?h[h.length-1]:null;
  return {base:tot,hr:st.bx.hashrate*1e9,t0:Date.now(),extra:last?Math.max(0,Math.min(s.now-last.t,1800)):0};
}
function tickText(){
  var e=$('tick');if(!TICK){e.hidden=true;return}
  var n=TICK.base+TICK.hr*(TICK.extra+(Date.now()-TICK.t0)/1000);
  e.textContent='Hashes tried since the client started: '+hnum(n,2)+'. Each one is a lottery ticket for a block.';e.hidden=false;
}
setInterval(tickText,1000);
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
  g.appendChild(kpi('Declaration latency',st.lat!=null?Math.round(st.lat)+' ms':'–','pool reply to my job, a found block does not wait for it','t'));
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
  [['Transactions',fmt(dc.txCount)],['Avg fee rate',dc.feeRate==null?'–':dc.feeRate.toFixed(1)+' sat/vB'],['Accelerated',dc.accel==null?fmt(dc.prioritized):fmt(dc.accel)+(d&&d.prio&&d.prio.manual?' + '+fmt(d.prio.manual)+' manual':'')]].forEach(function(q){var x=el('div');x.appendChild(el('div','k',q[0]));x.appendChild(el('div','v',q[1]));mini.appendChild(x)});
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
/* ---------- prioritised transactions ---------- */
function renderPrio(st,l){
  var g=$('prg'),d=l.dmnd,pr=d&&d.prio,dc=st.decl;g.textContent='';
  $('prnote').textContent='Because my node builds the block, I can move a transaction up the queue by adding a fee delta to it: my own, or one boosted through mempool.space. The pool has no say in it. Zero is normal when nobody has a stuck transaction.';
  if(!pr||pr.enabled==null){g.appendChild(el('div','card empty','Prioritisation is not reporting.'));return}
  var inMine=dc?(dc.accel!=null?dc.accel:0)+(dc.prioritized||0):null;
  g.appendChild(stat('Feature',pr.enabled?'On':'Off',pr.enabled?'reads the mempool.space accelerator feed':'needs RPC access and an API token',pr.enabled?'t':''));
  g.appendChild(stat('In my block now',inMine==null?'–':fmt(inMine),'boosted transactions in the declared template',inMine?'t':''));
  g.appendChild(stat('From mempool.space',pr.mempoolSpace==null?'–':fmt(pr.mempoolSpace),'the client is tracking right now'));
  g.appendChild(stat('Added by me',pr.manual==null?'–':fmt(pr.manual),'manual fee deltas through the client API'));
}
/* ---------- RSK merge mining ---------- */
function renderRsk(l){
  var g=$('rsk'),r=l.rsk;g.textContent='';
  $('rsknote').textContent='Merge mining lets the same hashes also count toward RSK, a Bitcoin sidechain. A small RSK node on this laptop hands the DMND client a commitment that goes into my coinbase, so it costs no extra hash power. At my size an RSK block is very unlikely, so this shows the feature working and is not income.';
  if(!r){g.appendChild(el('div','card empty','The RSK node is not reporting.'));return}
  var mm=r.mm||{};
  g.appendChild(stat('RSK node',r.synced?'Synced':'Syncing',r.block!=null?'block '+fmt(r.block):'','t'));
  g.appendChild(stat('Latest block age',r.tipAge==null?'–':ago(r.tipAge),r.peers!=null?fmt(r.peers)+' peers':''));
  g.appendChild(stat('Bridge',r.bridge==null?'–':r.bridge?'Running':'Stopped','sends RSK work to the client',r.bridge?'t':''));
  g.appendChild(stat('Work for the miner',mm.work==null?'–':mm.work?'Yes':'No',mm.configured?'merge mining is on':'merge mining is off'));
  g.appendChild(stat('RSK blocks found',mm.found==null?'–':fmt(mm.found),mm.pending?fmt(mm.pending)+' proofs pending':'none expected soon'));
  g.appendChild(stat('RSK database',r.dbBytes==null?'–':gb(r.dbBytes),'RSK chain data on this laptop'));
}
/* ---------- mempool.space ---------- */
function renderClient(st){
  var g=$('cpg'),d=st.d,sv0=st.sv;g.textContent='';
  if(!d){dimmed(g,['Miners connected','Shares accepted','Share difficulty','Declaration latency'],sv0.client?'waiting for client data':'client down');return}
  var s=d.stats||{},p=d.pool||{};
  g.appendChild(stat('Miners connected',fmt(s.total_connected_device!=null?s.total_connected_device:sv0.miners),'over Stratum V1'));
  g.appendChild(stat('Shares accepted',fmt(s.aggregate_accepted_shares),s.aggregate_rejected_shares!=null?fmt(s.aggregate_rejected_shares)+' rejected':''));
  g.appendChild(stat('Share difficulty',s.aggregate_diff!=null?hnum(s.aggregate_diff,1):'–','set by the pool'));
  g.appendChild(stat('Declaration latency',p.declaration_latency_ms!=null?Math.round(p.declaration_latency_ms)+' ms':'–','pool reply to a declared job, a found block does not wait for it'));
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
  detectEvents(l,st.bx);TICK=hashesTried(s,st);tickText();
  if(st.stale){txt='Offline';pill.className='pill bad'}
  else if(st.hashing&&st.decl){txt='Mining';pill.className='pill ok'}
  else if(!st.synced){txt='Node syncing';pill.className='pill sync'}
  else if(!st.sv.client||!st.sv.tp){txt='Stack down';pill.className='pill bad'}
  else{txt='Starting';pill.className='pill sync'}
  $('statustxt').textContent=txt;
  $('meta').textContent='Bitcoin Core '+(l.version||'').replace(/^Satoshi:/,'v')+' · sv2-tp · DMND client · Bitaxe Gamma · updated '+ago(st.age);
  renderStory(st);renderDiagram(st);renderKpis(st,s);renderBlock(st);renderClient(st);renderBitaxe(st);
  renderVs(s);renderRsk(l);renderPrio(st,l);renderDgCard();renderShares(s);renderOdds(l,s);renderNode(st,s);
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
}
function load(){fetch('/api/stats').then(function(r){return r.json()}).then(render).catch(function(){$('meta').textContent='could not load stats'})}
var TABS=['over','block','miner','nodes'];
function tab(n,keep){TABS.forEach(function(k){$('p-'+k).hidden=k!==n;$('t-'+k).setAttribute('aria-selected',k===n)});
  if(!keep){try{history.replaceState(null,'','#'+n)}catch(e){}}
  if(LAST&&LAST.latest)renderDiagram(derive(LAST))}
TABS.forEach(function(k){$('t-'+k).onclick=function(){tab(k)}});
var h0=(location.hash||'').slice(1);if(TABS.indexOf(h0)>=0)tab(h0,true);
/* iOS Safari fires resize when its toolbar collapses while scrolling: only redraw when the width changed. */
var rt=null,rw=window.innerWidth;window.addEventListener('resize',function(){if(window.innerWidth===rw)return;rw=window.innerWidth;clearTimeout(rt);rt=setTimeout(function(){if(LAST&&LAST.latest)renderDiagram(derive(LAST))},150)});
load();setInterval(load,30000);
})();
</script></body></html>`;
