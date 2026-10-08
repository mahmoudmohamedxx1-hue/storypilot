// Auto-generated from scripts/drive_sync.py - do not edit by hand;
// regenerate with scripts/gen-bundle-templates.py
// Hourly Google Drive sync: uploads every finished video bundle to the user's Drive via their Apps Script web app (base64 protocol, deduped in state/drive_sync.json, never blocks rendering)
export const DRIVE_SYNC_PY = `#!/usr/bin/env python3
"""StoryPilot - Hourly Google Drive sync.

Every finished factory video ends up in your Google Drive, synced at most once
per hour (DRIVE_SYNC_INTERVAL_SEC, default 3600):

    videos/01-ab12cd34/output.mp4   ->  "StoryPilot Videos/2026-10-07 Title [ab12cd34]/output.mp4"
                                       (+ meta.json, story.json, thumb.jpg, ai_renderer.py)

The upload target is an Apps Script Web App that YOU own (script.google.com,
bound to the same Google account as the Spark sheet - no OAuth secrets in CI).
Protocol (base64 over HTTP so binary MP4s survive the trip):

    GET  {url}?action=ping                     -> {"ok": true, "root": "StoryPilot Videos"}
    POST {url}?filename=..&folder=..&mime=..&b64=1[&key=..]
         body = base64(file bytes)             -> {"ok": true, "fileId": .., "url": ..}

Dedup lives in state/drive_sync.json (committed to the repo): a video dir is
uploaded once; the hourly factory loop calls maybe_sync() which only fires when
the TTL has elapsed AND new finished videos exist. Failures never break video
production - they are retried on the next tick.

Environment:
    DRIVE_WEBAPP_URL      the /exec URL of your Apps Script web app (secret)
    DRIVE_WEBAPP_KEY      optional shared secret you configured in the script
    DRIVE_ROOT_FOLDER     Drive folder name, default "StoryPilot Videos"
    DRIVE_SYNC_INTERVAL   seconds between sync passes, default 3600 (hourly)
    DRIVE_MAX_MB          skip single files larger than this (Apps Script 50MB cap), default 32

CLI:
    python scripts/drive_sync.py            sync new videos now (respects dedup)
    python scripts/drive_sync.py --force    re-upload every video dir
    python scripts/drive_sync.py --ping     health-check the web app
    python scripts/drive_sync.py --status   print the local sync state
"""
import base64
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
os.chdir(ROOT)

import render_pending as rp  # noqa: E402  (VIDEOS_DIR + state helpers, same paths)

WEBAPP_URL = os.environ.get("DRIVE_WEBAPP_URL", "").strip()
WEBAPP_KEY = os.environ.get("DRIVE_WEBAPP_KEY", "").strip()
ROOT_FOLDER = os.environ.get("DRIVE_ROOT_FOLDER", "StoryPilot Videos").strip() or "StoryPilot Videos"
SYNC_INTERVAL = float(os.environ.get("DRIVE_SYNC_INTERVAL", "3600"))
MAX_BYTES = int(float(os.environ.get("DRIVE_MAX_MB", "32")) * 1024 * 1024)
STATE_PATH = os.environ.get("DRIVE_STATE_PATH", "state/drive_sync.json")
TIMEOUT_SEC = float(os.environ.get("DRIVE_TIMEOUT", "180"))

# Files that make a video dir "finished" and worth syncing (first = required).
BUNDLE_FILES = ["output.mp4", "meta.json", "story.json", "thumb.jpg", "ai_renderer.py"]


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def log(msg):
    print(f"[drive] {msg}", flush=True)


def load_state():
    try:
        with open(STATE_PATH, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"uploaded": {}, "last_sync": None, "last_error": None, "files_total": 0}


def save_state(st):
    os.makedirs(os.path.dirname(STATE_PATH) or ".", exist_ok=True)
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(st, f, ensure_ascii=False, indent=2)
    os.replace(tmp, STATE_PATH)


def _full_url(params):
    q = dict(params)
    if WEBAPP_KEY:
        q["key"] = WEBAPP_KEY
    sep = "&" if "?" in WEBAPP_URL else "?"
    return WEBAPP_URL + sep + urllib.parse.urlencode(q)


def _open_no_redirect(req):
    """urllib open that does NOT auto-follow redirects (Apps Script 302s must be
    re-POSTed with the same body, which auto-follow would drop)."""
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **kw):
            return None
    opener = urllib.request.build_opener(NoRedirect)
    return opener.open(req, timeout=TIMEOUT_SEC)


def _request(method, url, data=None, headers=None):
    """Send a request; manually follow up to 5 redirects preserving method+body."""
    for _ in range(6):
        req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
        try:
            with _open_no_redirect(req) as r:
                return r.status, r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            loc = e.headers.get("Location")
            if e.code in (301, 302, 303, 307, 308) and loc:
                url = urllib.parse.urljoin(url, loc)
                continue
            body = b""
            try:
                body = e.read()
            except Exception:
                pass
            raise RuntimeError(f"HTTP {e.code}: {body[:200].decode('utf-8', 'replace')}")
    raise RuntimeError("too many redirects")


def ping():
    """Health-check the web app. Returns (ok, info-string)."""
    if not WEBAPP_URL:
        return False, "DRIVE_WEBAPP_URL not configured"
    status, body = _request("GET", _full_url({"action": "ping"}))
    try:
        data = json.loads(body)
    except Exception:
        return False, f"non-JSON reply ({status}): {body[:120]}"
    if not data.get("ok"):
        return False, f"webapp rejected ping: {data.get('error', body[:120])}"
    return True, data


def upload_file(path, subfolder):
    """Upload one file into Drive subfolder. Returns the webapp JSON dict."""
    size = os.path.getsize(path)
    if size > MAX_BYTES:
        return {"ok": False, "error": f"too large ({size / 1e6:.1f}MB > {MAX_BYTES / 1e6:.0f}MB cap)"}
    mime = "video/mp4" if path.endswith(".mp4") else (
        "image/jpeg" if path.endswith(".jpg") else "application/json"
        if path.endswith(".json") else "text/x-python" if path.endswith(".py") else
        "application/octet-stream")
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    status, body = _request("POST", _full_url({
        "filename": os.path.basename(path),
        "folder": subfolder,
        "mime": mime,
        "b64": "1",
    }), data=b64.encode("ascii"), headers={"Content-Type": "text/plain"})
    try:
        data = json.loads(body)
    except Exception:
        raise RuntimeError(f"non-JSON reply ({status}): {body[:150]}")
    if not data.get("ok"):
        raise RuntimeError(f"webapp error: {data.get('error', body[:150])}")
    return data


def _safe_name(s, fallback="video"):
    s = re.sub(r'[\\\\/:*?"<>|\\r\\n\\t]+', " ", str(s or ""))
    s = re.sub(r"\\s+", " ", s).strip()
    return (s[:70] or fallback)


def video_dirs():
    if not os.path.isdir(rp.VIDEOS_DIR):
        return []
    out = []
    for name in sorted(os.listdir(rp.VIDEOS_DIR)):
        d = os.path.join(rp.VIDEOS_DIR, name)
        if os.path.isdir(d) and os.path.exists(os.path.join(d, "output.mp4")):
            out.append(d)
    return out


def _dir_label(d):
    """Human folder name for one video dir: 'YYYY-MM-DD Title [hash8]'."""
    title = ""
    try:
        with open(os.path.join(d, "meta.json"), encoding="utf-8") as f:
            title = json.load(f).get("title", "")
    except Exception:
        pass
    base = os.path.basename(d)
    h8 = base.split("-")[-1][:8] if "-" in base else base[:8]
    day = time.strftime("%Y-%m-%d", time.gmtime(os.path.getmtime(d)))
    return f"{day} {_safe_name(title or base)} [{h8}]"


def sync_all(force=False):
    """Upload every finished video dir not yet in the state file.

    Returns a summary dict: {uploaded_dirs, skipped, files, errors:[..]}.
    Never raises - Drive problems must not stop video production.
    """
    st = load_state()
    summary = {"uploaded_dirs": 0, "skipped": 0, "files": 0, "errors": []}
    if not WEBAPP_URL:
        summary["errors"].append("DRIVE_WEBAPP_URL not configured - sync skipped")
        return summary
    for d in video_dirs():
        key = os.path.basename(d)
        if key in st["uploaded"] and not force:
            summary["skipped"] += 1
            continue
        label = _dir_label(d)
        files_ok = []
        errs = []
        for name in BUNDLE_FILES:
            p = os.path.join(d, name)
            if not os.path.exists(p):
                if name == "output.mp4":
                    errs.append("output.mp4 missing")
                continue
            try:
                res = upload_file(p, label)
                files_ok.append(name)
                if res.get("url"):
                    st["uploaded"].setdefault(key, {"files": {}})["files"][name] = res["url"]
            except Exception as e:
                errs.append(f"{name}: {str(e)[:160]}")
        if "output.mp4" in files_ok:
            st["uploaded"][key] = {"at": now_iso(), "folder": label,
                                   "files": st["uploaded"].get(key, {}).get("files", {})}
            summary["uploaded_dirs"] += 1
            summary["files"] += len(files_ok)
            st["files_total"] = int(st.get("files_total", 0)) + len(files_ok)
            log(f"uploaded '{label}' ({len(files_ok)} files)")
        if errs:
            summary["errors"].extend(errs)
            log(f"::warning::partial upload for {key}: {'; '.join(errs)[:200]}")
    st["last_sync"] = now_iso()
    st["last_error"] = "; ".join(summary["errors"])[:300] or None
    if summary["uploaded_dirs"] or summary["errors"]:
        save_state(st)
    else:
        st2 = load_state()
        st2["last_sync"] = st["last_sync"]
        save_state(st2)
    return summary


def maybe_sync(respect_ttl=True, force=False):
    """Hourly-throttled entry point the factory calls after every video.

    respect_ttl=False forces a pass right now (used on graceful shutdown);
    dedup still applies unless force=True.
    """
    if not WEBAPP_URL:
        return {"skipped": "not_configured"}
    st = load_state()
    if respect_ttl and st.get("last_sync"):
        try:
            last = time.mktime(time.strptime(st["last_sync"], "%Y-%m-%dT%H:%M:%SZ"))
        except Exception:
            last = 0
        if time.time() - last < SYNC_INTERVAL:
            return {"skipped": "ttl"}
    try:
        return sync_all(force=force)
    except Exception as e:
        log(f"::warning::drive sync failed: {str(e)[:200]} (retrying next hour)")
        st2 = load_state()
        st2["last_error"] = str(e)[:300]
        save_state(st2)
        return {"error": str(e)[:300]}


def drive_status():
    """Small status block the factory merges into factory_status.json."""
    st = load_state()
    return {
        "configured": bool(WEBAPP_URL),
        "root_folder": ROOT_FOLDER if WEBAPP_URL else "",
        "last_sync": st.get("last_sync"),
        "dirs_uploaded": len(st.get("uploaded", {})),
        "files_total": st.get("files_total", 0),
        "last_error": st.get("last_error"),
        "interval_sec": int(SYNC_INTERVAL),
    }


if __name__ == "__main__":
    args = set(sys.argv[1:])
    if "--ping" in args:
        ok, info = ping()
        print(json.dumps({"ok": ok, "info": info}, ensure_ascii=False, indent=2))
        sys.exit(0 if ok else 1)
    if "--status" in args:
        print(json.dumps(drive_status(), ensure_ascii=False, indent=2))
        sys.exit(0)
    res = sync_all(force="--force" in args)
    print(json.dumps(res, ensure_ascii=False, indent=2))
    log(f"sync pass done: {res['uploaded_dirs']} dirs / {res['files']} files uploaded, "
        f"{res['skipped']} skipped, {len(res['errors'])} errors")
`
