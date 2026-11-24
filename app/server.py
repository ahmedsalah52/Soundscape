"""Local web server: folder loading, background analysis, JSON API, audio streaming."""
from __future__ import annotations

import argparse
import csv
import io
import mimetypes
import os
import re
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from concurrent.futures import ProcessPoolExecutor
from typing import Optional

import uvicorn
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import aggregate as agg
from . import cache
from .analysis import DEFAULT_BANDS, analyze_file, normalize_bands
from .spectro import spectrogram
from .catalog import AudioFile, scan

STATIC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static")
RES_MAP = {"auto": None, "0.125": 0.125, "1": 1.0, "10": 10.0, "60": 60.0, "300": 300.0}


class State:
    def __init__(self):
        self.lock = threading.Lock()
        self.folder: Optional[str] = None
        self.files: list[AudioFile] = []
        self.tracks: dict[str, agg.Track] = {}
        self.status: dict[str, str] = {}
        self.errors: dict[str, str] = {}
        self.gen = 0
        self.started = 0.0
        self.executor: Optional[ProcessPoolExecutor] = None
        try:
            self.bands = normalize_bands(cache.read_settings().get("bands"))
        except ValueError:
            self.bands = dict(DEFAULT_BANDS)

    def load_folder(self, folder: str) -> None:
        folder = os.path.abspath(os.path.expanduser(folder))
        if not os.path.isdir(folder):
            raise HTTPException(400, f"Not a folder: {folder}")
        files = scan(folder)
        with self.lock:
            self.gen += 1
            gen = self.gen
            if self.executor:
                self.executor.shutdown(wait=False, cancel_futures=True)
            self.executor = None
            self.folder, self.files = folder, files
            self.tracks, self.status, self.errors = {}, {}, {}
            self.started = time.time()
            agg.clear_registry()
        cache.write_settings(last_folder=folder)
        todo = []
        bands = dict(self.bands)
        for f in files:
            data = cache.load(f.path, f.size, f.mtime, bands)
            if data is not None:
                self._done(gen, f, data)
            else:
                self.status[f.id] = "pending"
                todo.append(f)
        if todo:
            workers = max(1, min(len(todo), (os.cpu_count() or 2) - 1))
            ex = ProcessPoolExecutor(max_workers=workers)
            with self.lock:
                self.executor = ex
            for f in todo:
                fut = ex.submit(analyze_file, f.path, bands)
                fut.add_done_callback(lambda fu, f=f: self._finish(gen, f, fu, bands))

    def _finish(self, gen, f, fut, bands):
        if fut.cancelled():
            return
        try:
            data = fut.result()
        except Exception as e:  # noqa: BLE001
            with self.lock:
                if gen == self.gen:
                    self.status[f.id] = "error"
                    self.errors[f.id] = f"{type(e).__name__}: {e}"
            return
        cache.save(f.path, f.size, f.mtime, data, bands)
        self._done(gen, f, data)

    def _done(self, gen, f, data):
        with self.lock:
            if gen != self.gen:
                return
            tr = agg.Track(f, data)
            self.tracks[f.id] = tr
            self.status[f.id] = "done"
            agg.register(tr)

    # ---- scope helpers -------------------------------------------------
    def ready(self) -> list[agg.Track]:
        with self.lock:
            return [self.tracks[f.id] for f in self.files if f.id in self.tracks]

    def places(self) -> list[str]:
        with self.lock:
            return list(dict.fromkeys(f.place for f in self.files))

    def in_place(self, place: Optional[str]) -> list[agg.Track]:
        tr = self.ready()
        return [t for t in tr if t.file.place == place] if place else tr

    def by_day(self, place: Optional[str] = None) -> dict[str, list[agg.Track]]:
        out: dict[str, list[agg.Track]] = {}
        for t in sorted(self.in_place(place), key=lambda t: (t.file.day, t.file.place, t.file.start)):
            out.setdefault(t.file.day, []).append(t)
        return dict(sorted(out.items()))

    def by_place(self, tracks: Optional[list[agg.Track]] = None) -> dict[str, list[agg.Track]]:
        out: dict[str, list[agg.Track]] = {p: [] for p in self.places()}
        for t in (self.ready() if tracks is None else tracks):
            out.setdefault(t.file.place, []).append(t)
        return {p: v for p, v in out.items() if v}

    def scope(self, scope: str, id: Optional[str], place: Optional[str] = None) -> list[agg.Track]:
        tr = self.in_place(place)
        if scope == "file":
            tr = [t for t in tr if t.file.id == id]
        elif scope == "day":
            tr = [t for t in tr if t.file.day == id]
        if not tr:
            raise HTTPException(404, "Nothing analysed yet for this selection")
        return tr

    def file(self, fid: str) -> AudioFile:
        for f in self.files:
            if f.id == fid:
                return f
        raise HTTPException(404, "Unknown file")


S = State()
app = FastAPI(title="Soundscape Loudness Panel")


class FolderBody(BaseModel):
    path: str


@app.post("/api/folder")
def api_folder(body: FolderBody):
    S.load_folder(body.path)
    return api_status()


@app.post("/api/pick-folder")
def api_pick_folder():
    if sys.platform != "darwin":
        raise HTTPException(501, "Native picker only on macOS - paste the path instead")
    script = 'POSIX path of (choose folder with prompt "Choose a folder with audio recordings")'
    try:
        r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=600)
    except subprocess.TimeoutExpired:
        raise HTTPException(408, "Folder dialog timed out")
    path = r.stdout.strip()
    if r.returncode != 0 or not path:
        return {"cancelled": True}
    S.load_folder(path)
    return {"cancelled": False, **api_status()}


class DropFile(BaseModel):
    name: str
    size: int


class DropBody(BaseModel):
    name: str
    is_dir: bool = True
    files: list[DropFile] = []


def _mdfind(name: str) -> list[str]:
    q = 'kMDItemFSName == "%s"' % name.replace("\\", "\\\\").replace('"', '\\"')
    try:
        r = subprocess.run(["mdfind", q], capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        return []
    return [l for l in r.stdout.splitlines() if l.strip()]


@app.post("/api/resolve-drop")
def api_resolve_drop(body: DropBody):
    """Browsers hide real paths of dropped items; find the folder via Spotlight
    by its name and the sizes of the files inside it."""
    if sys.platform != "darwin":
        raise HTTPException(501, "Drag & drop lookup needs macOS Spotlight - use Open folder")
    if body.is_dir:
        cands = [c for c in _mdfind(body.name) if os.path.isdir(c)]
        score = lambda c: sum(
            1 for f in body.files
            if os.path.isfile(os.path.join(c, f.name)) and os.path.getsize(os.path.join(c, f.name)) == f.size)
    else:
        first = body.files[0] if body.files else None
        hits = [c for c in _mdfind(first.name)] if first else []
        cands = sorted({os.path.dirname(c) for c in hits
                        if os.path.isfile(c) and os.path.getsize(c) == first.size})
        score = lambda c: sum(
            1 for f in body.files
            if os.path.isfile(os.path.join(c, f.name)) and os.path.getsize(os.path.join(c, f.name)) == f.size)
    ranked = sorted(((score(c), c) for c in cands), reverse=True)
    if not ranked or (body.files and ranked[0][0] == 0):
        raise HTTPException(404, "Could not locate the dropped folder - use Open folder… instead")
    S.load_folder(ranked[0][1])
    return api_status()


@app.get("/api/status")
def api_status():
    with S.lock:
        vals = list(S.status.values())
        return {
            "folder": S.folder, "total": len(S.files),
            "done": vals.count("done"), "error": vals.count("error"),
            "pending": vals.count("pending"), "errors": dict(S.errors),
            "elapsed": round(time.time() - S.started, 1) if S.started else 0,
            "bands": {k: list(v) for k, v in S.bands.items()},
            "default_bands": {k: list(v) for k, v in DEFAULT_BANDS.items()},
        }


class BandsBody(BaseModel):
    anthro: list[float]
    bio: list[float]


@app.post("/api/bands")
def api_bands(body: BandsBody):
    """Change the anthrophony / biophony band limits (Hz) and re-analyse (cached per setting)."""
    try:
        bands = normalize_bands({"anthro": body.anthro, "bio": body.bio})
    except (ValueError, IndexError) as e:
        raise HTTPException(400, str(e))
    for k, (lo, hi) in bands.items():
        if hi > 96000:
            raise HTTPException(400, f"{k}: upper limit too high")
    S.bands = bands
    cache.write_settings(bands={k: list(v) for k, v in bands.items()})
    if S.folder:
        S.load_folder(S.folder)
    return api_status()


@app.get("/api/spectrogram")
def api_spectrogram(scope: str = "all", id: Optional[str] = None, x0: Optional[float] = None,
                    x1: Optional[float] = None, cols: int = 1200, place: Optional[str] = None):
    return spectrogram(S.scope(scope, id, place), x0, x1, cols)


@app.get("/api/catalog")
def api_catalog():
    with S.lock:
        files = [{**f.to_json(), "status": S.status.get(f.id, "pending")} for f in S.files]
    days = sorted({f["day"] for f in files})
    places = []
    for p in dict.fromkeys(f["place"] for f in files):
        pf = [f for f in files if f["place"] == p]
        places.append({"name": p, "files": len(pf), "days": sorted({f["day"] for f in pf})})
    return {"folder": S.folder, "files": files, "days": days, "places": places}


def _res(res: str):
    if res not in RES_MAP:
        raise HTTPException(400, "bad res")
    return RES_MAP[res]


@app.get("/api/series")
def api_series(scope: str = "all", id: Optional[str] = None, res: str = "auto",
               weighting: str = "A", x0: Optional[float] = None, x1: Optional[float] = None,
               place: Optional[str] = None):
    return agg.series(S.scope(scope, id, place), _res(res), weighting, x0, x1)


@app.get("/api/compare")
def api_compare(scope: str = "all", id: Optional[str] = None, res: str = "auto",
                weighting: str = "A", metric: str = "leq",
                x0: Optional[float] = None, x1: Optional[float] = None):
    """All places side by side on a shared clock-time axis (scope all or day)."""
    return agg.compare(S.by_place(S.scope(scope, id)), _res(res), weighting, metric, x0, x1)


@app.get("/api/overlay")
def api_overlay(res: str = "auto", weighting: str = "A", metric: str = "leq",
                place: Optional[str] = None):
    return agg.overlay(S.by_day(place), _res(res), weighting, metric)


def _groups(group: str, place: Optional[str] = None) -> list[tuple]:
    """(label, place, tracks) per summary row. Day groups never mix places."""
    trs = S.in_place(place)
    if group == "file":
        return [(t.file.name, t.file.place, [t]) for t in trs]
    if group == "place":
        return [(p, p, v) for p, v in S.by_place(trs).items()]
    if group == "day":
        out = []
        for p, v in S.by_place(trs).items():
            days: dict[str, list] = {}
            for t in v:
                days.setdefault(t.file.day, []).append(t)
            out += [(d, p, ts) for d, ts in sorted(days.items())]
        return out
    return [("All recordings", place or (S.places()[0] if len(S.places()) == 1 else None), trs)]


@app.get("/api/summary")
def api_summary(group: str = "file", weighting: str = "A", threshold: Optional[float] = None,
                place: Optional[str] = None):
    return agg.summary(_groups(group, place), weighting, threshold)


@app.get("/api/heatmap")
def api_heatmap(metric: str = "leq", weighting: str = "A", slot: float = Query(300.0, ge=10),
                rows: str = "day", place: Optional[str] = None):
    """rows=day: one row per (place, day); rows=place: one 'typical day' row per place."""
    bp = S.by_place(S.in_place(place))
    if rows == "place":
        spec = [{"label": p, "place": p, "day": None, "tracks": v} for p, v in bp.items()]
    else:
        spec = []
        for p, v in bp.items():
            days: dict[str, list] = {}
            for t in v:
                days.setdefault(t.file.day, []).append(t)
            spec += [{"label": d, "place": p, "day": d, "tracks": ts} for d, ts in sorted(days.items())]
    return agg.heatmap(spec, weighting, metric, slot)


@app.get("/api/events")
def api_events(scope: str = "all", id: Optional[str] = None, weighting: str = "A", n: int = 20,
               place: Optional[str] = None):
    return agg.events(S.scope(scope, id, place), weighting, n)


@app.get("/api/audio/{fid}")
def api_audio(fid: str):
    f = S.file(fid)
    mt = mimetypes.guess_type(f.path)[0] or "application/octet-stream"
    if f.path.lower().endswith(".wav"):
        mt = "audio/wav"
    return FileResponse(f.path, media_type=mt)


@app.get("/api/export.csv")
def api_export(kind: str = "summary", group: str = "file", weighting: str = "A",
               threshold: Optional[float] = None, scope: str = "all",
               id: Optional[str] = None, res: str = "60", offset: float = 0.0,
               place: Optional[str] = None):
    buf = io.StringIO()
    w = csv.writer(buf)
    unit = "dBFS" if not offset else "dB_SPL_approx"
    if kind == "summary":
        rows = agg.summary(_groups(group, place), weighting, threshold)
        cols = ["place", "label", "day", "start", "files", "duration", "leq", "l10", "l50", "l90",
                "lmax", "anthro", "bio", "ndsi"] + (["pct_above"] if threshold is not None else [])
        w.writerow([f"{c}_{unit}" if c in agg.METRICS and c != "ndsi" else c for c in cols])
        for r in rows:
            w.writerow([(r.get(c) + offset if c in agg.METRICS and c != "ndsi" and r.get(c) is not None
                         else r.get(c)) for c in cols])
        name = f"summary_{group}_{place or 'all-places'}_{weighting}.csv"
    else:
        trs = S.scope(scope, id, place)
        segs = agg.segments(trs)
        w.writerow(["place", "file", "clock_time", "offset_s"] + [f"{m}_{unit}" if m != "ndsi" else m for m in agg.METRICS])
        r = _res(res) or 60.0
        for seg, tr in zip(segs, trs):
            b = agg.binned(tr, r, weighting)
            for i, t in enumerate(b["t"]):
                clock = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(seg["start_epoch"] + t))
                vals = []
                for m in agg.METRICS:
                    v = float(b[m][i])
                    vals.append("" if v != v else round(v + (offset if m != "ndsi" else 0), 3))
                w.writerow([tr.file.place, tr.file.name, clock, round(float(t), 3)] + vals)
        name = f"series_{place or 'all-places'}_{scope}_{id or 'all'}_{weighting}_{r}s.csv"
    name = re.sub(r"[^\w.\-]+", "_", name)
    return PlainTextResponse(buf.getvalue(), media_type="text/csv",
                             headers={"Content-Disposition": f'attachment; filename="{name}"'})


@app.exception_handler(HTTPException)
def _http_exc(_, exc: HTTPException):
    return JSONResponse({"error": exc.detail}, status_code=exc.status_code)


app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")


def _free_port(start: int) -> int:
    for p in range(start, start + 50):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    raise RuntimeError("no free port")


def main():
    ap = argparse.ArgumentParser(description="Soundscape Loudness Panel")
    ap.add_argument("folder", nargs="?", help="folder with audio files")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()
    folder = a.folder or cache.read_settings().get("last_folder")
    if folder and os.path.isdir(folder):
        print(f"Loading {folder}")
        S.load_folder(folder)
    port = _free_port(a.port)
    url = f"http://127.0.0.1:{port}/"
    print(f"\n  Soundscape Loudness Panel → {url}\n  (Ctrl+C to stop)\n")
    if not a.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
