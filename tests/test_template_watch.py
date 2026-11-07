"""Tests for template_watch.py. Run: python3 -I tests/test_template_watch.py"""
import importlib.util, json, os, sys, tempfile, random
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("tw", os.path.join(HERE, "..", "template_watch.py")); tw = importlib.util.module_from_spec(spec); spec.loader.exec_module(tw)
fails = 0
def check(name, cond):
    global fails
    print(("ok   " if cond else "FAIL ") + name); fails += not cond
def T(h, tid, fees, fut=False, recv=0): return {"height": h, "template_id": tid, "total_fees_sat": fees, "tx_count": 10, "total_weight": 3_990_000, "received_at": recv, "future_template": fut}

# 1. normal block change: last declared template for H wins, closed when H+1 is declared
hs = {}
tw.step(hs, {"active_declaration": 1, "templates": [T(100, 1, 500, recv=0)]}, 1)
tw.step(hs, {"active_declaration": 2, "templates": [T(100, 2, 700, recv=5), T(100, 1, 500)]}, 6)
tw.step(hs, {"active_declaration": 3, "templates": [T(101, 3, 50, recv=8), T(100, 2, 700)]}, 8)
check("last declared fees kept", hs[100]["fees"] == 700)
check("height closed at block time", hs[100]["end"] == 8 and not hs[100]["stale"])
check("age = end - received", hs[100]["end"] - hs[100]["recv"] == 3)
check("new height open", hs[101]["end"] is None)

# 2. future template before the block must NOT close the height
hs = {}
tw.step(hs, {"active_declaration": 1, "templates": [T(200, 1, 500)]}, 1)
tw.step(hs, {"active_declaration": 1, "templates": [T(201, 9, 0, fut=True), T(200, 1, 500)]}, 3)
check("future template does not close height", hs[200]["end"] is None)
tw.step(hs, {"active_declaration": 9, "templates": [T(201, 9, 0, fut=True), T(200, 1, 500)]}, 4)
check("declared future template closes height", hs[200]["end"] == 4)

# 3. watcher/client was down across the block -> stale
hs = {}
tw.step(hs, {"active_declaration": 1, "templates": [T(300, 1, 500)]}, 1)
tw.step(hs, {"active_declaration": 5, "templates": [T(301, 5, 10)]}, 100)
check("gap before block marks stale", hs[300]["stale"] is True)

# 4. closed height never reopens or changes (late/out-of-order replies)
tw.step(hs, {"active_declaration": 1, "templates": [T(300, 1, 999)]}, 101)
check("closed height not overwritten", hs[300]["fees"] == 500)

# 5. garbage replies don't crash
for junk in [{}, {"templates": None}, {"templates": [None, 1, "x", {"height": "7"}]}, {"active_declaration": None, "templates": [T(400, None, None)]}]:
    try: tw.step(hs, junk, 200); ok = True
    except Exception as e: ok = False; print(" ", e)
    check("junk reply " + json.dumps(junk)[:40], ok)

# 6. client restart: template ids restart at 1 at the same height
hs = {}
tw.step(hs, {"active_declaration": 6000, "templates": [T(500, 6000, 800)]}, 1)
tw.step(hs, {"active_declaration": 1, "templates": [T(500, 1, 820)]}, 3)
check("restart keeps tracking same height", hs[500]["fees"] == 820)

# 7. random long run: invariants
hs = {}; h = 1000; tid = 0; now = 0
for i in range(20000):
    now += random.choice([1, 2, 2, 3])
    if random.random() < 0.003: h += 1
    tid += 1
    tl = [T(h, tid, random.randint(1, 10**7), recv=now)]
    if random.random() < 0.05: tl.append(T(h + 1, tid + 10**6, 0, fut=True))
    if random.random() < 0.02: continue  # missed poll
    tw.step(hs, {"active_declaration": tid, "templates": tl}, now)
open_h = [k for k, v in hs.items() if v["end"] is None]
check("only the newest height is open (%d heights)" % len(hs), open_h == [max(hs)])
check("every closed record has end >= recv", all(v["end"] >= (v["recv"] or 0) for v in hs.values() if v["end"]))

# 8. save/load round trip, cap and atomic file
d = tempfile.mkdtemp(); tw.OUT = os.path.join(d, "f.json")
tw.save(hs); back = tw.load()
check("save keeps last %d heights" % tw.KEEP, sorted(back) == sorted(hs)[-tw.KEEP:])
check("no temp file left", not os.path.exists(tw.OUT + ".tmp"))
open(tw.OUT, "w").write("{corrupt"); check("corrupt file loads as empty", tw.load() == {})
print("FAILURES:", fails)
sys.exit(1 if fails else 0)
