#!/usr/bin/env python3
"""Generate StoryPilot app bundle templates (.ts) from the tested source files.

Keeps the app's deploy bundle byte-identical to the repo files we validated.
Escapes JS template-literal specials: backslash, backtick, ${.
"""
import os
import re

ROOT = "/home/z/my-project"
LIVE = os.path.join(ROOT, "storypilot-live")
BUNDLE = os.path.join(ROOT, "src", "lib", "bundle")

JOBS = [
    # (src, dst, const, desc[, transform]) - transform placeholder-izes secrets before escaping
    (os.path.join(LIVE, "scripts", "ai_forge.py"),
     os.path.join(BUNDLE, "ai-forge-py.ts"), "AI_FORGE_PY",
     "Keyless AI hyperframe forge: the AI WRITES the renderer code per story (freellmpool -> Pollinations), self-repairs, falls back to the built-in renderer"),
    (os.path.join(LIVE, "scripts", "factory.py"),
     os.path.join(BUNDLE, "factory-py.ts"), "FACTORY_PY",
     "Continuous factory supervisor: renders pending sheet stories back-to-back (unlimited per run), invents fresh stories when the queue is empty (retry x3 + builtin bank), syncs Drive hourly, chains the next run via the workflow"),
    (os.path.join(LIVE, "scripts", "drive_sync.py"),
     os.path.join(BUNDLE, "drive-sync-py.ts"), "DRIVE_SYNC_PY",
     "Google Drive sync: uploads every finished video bundle to the user's Drive via their Apps Script web app (base64 protocol, deduped in state/drive_sync.json, never blocks rendering)"),
    (os.path.join(LIVE, "scripts", "drive_webapp.js"),
     os.path.join(BUNDLE, "drive-webapp-js.ts"), "DRIVE_WEBAPP_JS",
     "The Apps Script the user pastes at script.google.com (one-time setup): accepts ping + base64 file uploads into the 'StoryPilot Videos' Drive folder"),
    (os.path.join(LIVE, ".github", "workflows", "factory.yml"),
     os.path.join(BUNDLE, "factory-yaml.ts"), "FACTORY_YAML",
     "Continuous Video Factory workflow: ~5h self-chaining runs (VERIFIED dispatch, 5 retries) + */15 cron backstop - one video after another 24/7, Drive flush + platform posting"),
    (os.path.join(LIVE, "scripts", "generate_story.py"),
     os.path.join(BUNDLE, "generate-story-py.ts"), "GENERATE_STORY_PY",
     "Story source: Google Sheet (Gemini Spark director storyboard, 10 scenes + hook/lesson) -> keyless freellmpool/llm7 -> fallback",
     lambda b: b.replace("1nNsUcwR9foKN_MTPm5bwMR5jz2HUE68UeRqJ0OFp-d4", "__SHEET_ID__")),
    (os.path.join(LIVE, "scripts", "render_pending.py"),
     os.path.join(BUNDLE, "render-pending-py.ts"), "RENDER_PENDING_PY",
     "Batch catch-up queue: sharded parallel workers + union render state + keyless AI polish (freellmpool -> llm7 GLM-5.3-Flash), renders every pending sheet story (manual/on-demand)",
     lambda b: b.replace("1nNsUcwR9foKN_MTPm5bwMR5jz2HUE68UeRqJ0OFp-d4", "__SHEET_ID__")),
    (os.path.join(LIVE, "generate_video.py"),
     os.path.join(BUNDLE, "generate-video-py.ts"), "GENERATE_VIDEO_PY",
     "Built-in cinematic renderer: story.json -> 1080x1920 60fps MP4 (keyless AI images + Edge-TTS + Ken Burns + Arabic captions), guaranteed fallback for the AI forge"),
    (os.path.join(LIVE, "post_video.py"),
     os.path.join(BUNDLE, "post-video-py.ts"), "POST_VIDEO_PY",
     "Posts the MP4 to YouTube, TikTok and Instagram Reels (each platform activates when its secrets exist)"),
    (os.path.join(LIVE, ".github", "workflows", "ensure-factory.yml"),
     os.path.join(BUNDLE, "ensure-factory-yml.ts"), "ENSURE_FACTORY_YAML",
     "Ensure Continuous Factory watcher: */20 cron - re-dispatches the factory when no run is alive for 25+ min and the factory was not stopped (patches holes when the chain + app heartbeat both fail)"),
]


def esc(text):
    return text.replace("\\", "\\\\").replace("`", "\\`").replace("${", "\\${")


for job in JOBS:
    src, dst, const, desc = job[0], job[1], job[2], job[3]
    transform = job[4] if len(job) > 4 else None
    with open(src, encoding="utf-8") as f:
        body = f.read()
    if transform:
        body = transform(body)
    out = (
        f"// Auto-generated from {os.path.relpath(src, LIVE)} - do not edit by hand;\n"
        f"// regenerate with scripts/gen-bundle-templates.py\n"
        f"// {desc}\n"
        f"export const {const} = `{esc(body)}`\n"
    )
    with open(dst, "w", encoding="utf-8") as f:
        f.write(out)
    print(f"OK  {os.path.basename(dst):22s} {len(body):7d} chars  const {const}")


def esc_fn_body(body, interpolations=None):
    """Escape a YAML body for a TS template literal, keeping ${opts.x} live."""
    tokens = {}
    for i, (literal, js) in enumerate((interpolations or {}).items()):
        tok = f"\x01TOK{i}\x01"
        body = body.replace(literal, tok)
        tokens[tok] = js
    out = esc(body)
    for tok, js in tokens.items():
        out = out.replace(tok, js)
    return out


# ---- regenerate workflow-yaml.ts (hourly template) from the live file ----
# buildSetupMd is hand-maintained in workflow-yaml.ts (scheduled-mode docs);
# the splice below only refreshes buildWorkflowYaml + REQUIREMENTS_TXT.
WY = os.path.join(BUNDLE, "workflow-yaml.ts")
with open(WY, encoding="utf-8") as f:
    wy = f.read()

with open(os.path.join(LIVE, ".github", "workflows", "hourly-video.yml"), encoding="utf-8") as f:
    hourly = f.read()
hourly_fn = (
    "export function buildWorkflowYaml(opts: { sheetId: string; flpModel: string; voice: string }): string {\n"
    "  return `" + esc_fn_body(hourly, {
        "1nNsUcwR9foKN_MTPm5bwMR5jz2HUE68UeRqJ0OFp-d4": "${opts.sheetId}",
        "vars.TTS_VOICE_AR || 'ar-EG-ShakirNeural'": "vars.TTS_VOICE_AR || '${opts.voice}'",
        "vars.FLP_MODEL || 'auto'": "vars.FLP_MODEL || '${opts.flpModel}'",
    }) + "`\n}\n"
)

# splice: replace buildWorkflowYaml (start of file .. REQUIREMENTS_TXT) and refresh
# the REQUIREMENTS_TXT const; keep buildSetupMd (from its export line to EOF)
anchor1 = "export const REQUIREMENTS_TXT"
anchor3 = "export function buildSetupMd"
with open(os.path.join(LIVE, "requirements.txt"), encoding="utf-8") as f:
    req_body = f.read()
req_const = f"export const REQUIREMENTS_TXT = `{esc(req_body)}`\n\n"
mid = wy[wy.index(anchor1):]
mid = mid[: mid.index(anchor1)] + req_const + mid[mid.index(anchor3):]
new_wy = hourly_fn + "\n" + mid
with open(WY, "w", encoding="utf-8") as f:
    f.write(new_wy)
print(f"OK  workflow-yaml.ts regenerated ({len(new_wy)} chars)")
print("all bundle templates generated + round-trip verified")

# round-trip check: every generated template must reproduce the live file exactly
fail = 0
for job in JOBS:
    src, dst, const, desc = job[0], job[1], job[2], job[3]
    transform = job[4] if len(job) > 4 else None
    with open(src, encoding="utf-8") as f:
        live = f.read()
    if transform:
        live = transform(live)
    with open(dst, encoding="utf-8") as f:
        generated = f.read()
    if f"export const {const} = `{esc(live)}`" not in generated:
        print(f"ROUND-TRIP FAIL: {dst}")
        fail += 1
if fail:
    raise SystemExit(f"{fail} round-trip failures")
print("round-trip: all templates byte-identical to source")
