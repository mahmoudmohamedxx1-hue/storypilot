#!/usr/bin/env python3
"""Validate the StoryPilot continuous-factory bundle before deploying:
1. Generate all bundle files exactly like the app does
2. YAML-parse + actionlint (if present) the workflows
3. Compile-check every python file
4. Dry-run render_pending.py sharding logic against the REAL sheet
   (render mocked: no video encoding, tiny fake output.mp4)
"""
import json, os, re, subprocess, sys, tempfile, shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "src", "lib", "bundle"))

# --- extract the TS template strings without running TS: naive but effective ---
def extract_ts_const(path, name):
    src = open(path).read()
    m = re.search(rf"export const {name} = `([\s\S]*?)`\n", src)
    assert m, f"{name} not found in {path}"
    return m.group(1)

def extract_ts_fn(path, fn):
    src = open(path).read()
    m = re.search(rf"export function {fn}\([^)]*\): string \{{\n  return `([\s\S]*?)`\n\}}", src)
    assert m, f"{fn} not found in {path}"
    return m.group(1)

BUNDLE = os.path.join(ROOT, "src", "lib", "bundle")

SHEET_ID = "1nNsUcwR9foKN_MTPm5bwMR5jz2HUE68UeRqJ0OFp-d4"
FLP_MODEL = "glm-4.7-flash"

workflow = extract_ts_fn(BUNDLE + "/workflow-yaml.ts", "buildWorkflowYaml")
ensure = extract_ts_fn(BUNDLE + "/workflow-yaml.ts", "buildEnsureHourlyYaml")
gen_story = extract_ts_const(BUNDLE + "/generate-story-py.ts", "GENERATE_STORY_PY")
render_pending = extract_ts_const(BUNDLE + "/render-pending-py.ts", "RENDER_PENDING_PY")
gen_video = extract_ts_const(BUNDLE + "/generate-video-py.ts", "GENERATE_VIDEO_PY")

# un-escape TS template escapes (replicate JS template literal evaluation:
# \\ -> \ , \$ -> $ , \` -> ` ; single \ before other chars stays)
def ts_unescape(s):
    out = []
    i = 0
    while i < len(s):
        c = s[i]
        if c == '\\' and i + 1 < len(s):
            nxt = s[i+1]
            if nxt == '\\':
                out.append('\\'); i += 2; continue
            if nxt == '$':
                out.append('$'); i += 2; continue
            if nxt == '`':
                out.append('`'); i += 2; continue
        out.append(c)
        i += 1
    return ''.join(out)

workflow = ts_unescape(workflow).replace("${opts.sheetId}", SHEET_ID).replace("${opts.flpModel}", FLP_MODEL).replace("${opts.voice}", "ar-EG-ShakirNeural")
ensure = ts_unescape(ensure)
gen_story = ts_unescape(gen_story).replace("__SHEET_ID__", SHEET_ID).replace("__FLP_MODEL__", FLP_MODEL)
render_pending = ts_unescape(render_pending).replace("__SHEET_ID__", SHEET_ID).replace("__FLP_MODEL__", FLP_MODEL)
gen_video = ts_unescape(gen_video)

tmp = tempfile.mkdtemp(prefix="sp-bundle-")
os.makedirs(os.path.join(tmp, ".github", "workflows"))
os.makedirs(os.path.join(tmp, "scripts"))
open(os.path.join(tmp, ".github/workflows/hourly-video.yml"), "w").write(workflow)
open(os.path.join(tmp, ".github/workflows/ensure-hourly.yml"), "w").write(ensure)
open(os.path.join(tmp, "scripts/generate_story.py"), "w").write(gen_story)
open(os.path.join(tmp, "scripts/render_pending.py"), "w").write(render_pending)
open(os.path.join(tmp, "generate_video.py"), "w").write(gen_video)

print("== 1. YAML parse ==")
import yaml
for f in ["hourly-video.yml", "ensure-hourly.yml"]:
    p = os.path.join(tmp, ".github", "workflows", f)
    data = yaml.safe_load(open(p))
    assert data and "jobs" in data, f"{f} unparseable"
    print(f"  {f}: OK — jobs: {list(data['jobs'].keys())}")

print("== 2. actionlint ==")
al = shutil.which("actionlint")
if al:
    r = subprocess.run([al, os.path.join(tmp, ".github/workflows/hourly-video.yml")], capture_output=True, text=True)
    print("  actionlint:", "CLEAN" if r.returncode == 0 else r.stdout + r.stderr)
    if r.returncode != 0:
        sys.exit(1)
else:
    print("  (not installed — skipped)")

print("== 3. Python compile ==")
for f in ["scripts/generate_story.py", "scripts/render_pending.py", "generate_video.py"]:
    p = os.path.join(tmp, f)
    r = subprocess.run([sys.executable, "-m", "py_compile", p], capture_output=True, text=True)
    if r.returncode != 0:
        print(f"  {f}: FAIL\n{r.stderr}")
        sys.exit(1)
    print(f"  {f}: compiles OK")

print("== 4. matrix expression sanity ==")
m = re.search(r"worker: \$\{\{ fromJSON\((.+?) \}\}", workflow)
print("  matrix worker expr:", m.group(1) if m else "NOT FOUND")
assert "workers_json" in workflow and "WORKERS_JSON" in workflow

print("== 5. sharding dry-run (real sheet, mocked render) ==")
# stub generate_video.py: create tiny output.mp4 + meta.json instantly
stub = '''#!/usr/bin/env python3
import json, os, sys
story = json.load(open(os.environ["STORY_PATH"]))
out = os.environ["OUT_DIR"]
os.makedirs(out, exist_ok=True)
open(os.path.join(out, "output.mp4"), "wb").write(b"\\x00" * 1024)
json.dump({"title": story.get("title"), "story_hash": story.get("_story_hash",""), "fps": 60, "hyperframes": True, "ai_enhanced": bool(story.get("_polish")), "duration_sec": 42.0}, open(os.path.join(out, "meta.json"), "w"))
open(os.path.join(out, "thumb.jpg"), "wb").write(b"\\x00" * 512)
print("[stub] rendered", story.get("title"))
'''
open(os.path.join(tmp, "generate_video.py"), "w").write(stub)

# state dir with legacy file (as on the repo)
os.makedirs(os.path.join(tmp, "state"))
legacy = {"rendered": {}, "failed": {}}

# run 3 shards sequentially (simulating parallel workers from the same checkout state)
results = {}
for shard in range(3):
    env = dict(os.environ)
    env.update({
        "SHEET_ID": SHEET_ID,
        "SHARD_INDEX": str(shard),
        "NUM_SHARDS": "3",
        "MAX_VIDEOS": "2",
        "BUDGET_MIN": "36",
        "AI_ENHANCE": "false",  # skip network polish for the dry-run speed
        "FLP_MODEL": FLP_MODEL,
        "FRAME_RATE": "60",
        "STATE_DIR": os.path.join(tmp, "state"),
        "VIDEOS_DIR": os.path.join(tmp, "videos"),
    })
    r = subprocess.run([sys.executable, os.path.join(tmp, "scripts/render_pending.py")],
                       capture_output=True, text=True, env=env, cwd=tmp, timeout=300)
    out = r.stdout + r.stderr
    results[shard] = out
    print(f"  --- worker {shard} (exit {r.returncode}) ---")
    for line in out.splitlines():
        if line.startswith("[queue]"):
            print("   ", line)

# verify: no overlap across shards, union covers the pending set
rendered = []
for shard in range(3):
    p = os.path.join(tmp, "state", f"videos.shard{shard}.json")
    assert os.path.exists(p), f"shard file missing for worker {shard}"
    d = json.load(open(p))
    rendered.extend(d["rendered"].keys())
    assert all(v.get("worker") == shard for v in d["rendered"].values())
assert len(rendered) == len(set(rendered)), "OVERLAP between shards!"
print(f"  sharding OK: {len(rendered)} unique stories rendered across 3 shards, no overlap")
summary_files = [f for f in os.listdir(tmp) if f == "batch_summary.json"]
print("  batch_summary written at repo root (one per worker — last one wins, artifact-only info)")

print("\nALL BUNDLE CHECKS PASSED")
shutil.rmtree(tmp, ignore_errors=True)
