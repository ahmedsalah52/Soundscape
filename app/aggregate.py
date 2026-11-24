"""Energy-correct aggregation of 125 ms frame energies into plots & summaries.

All levels are dB re full-scale RMS (dBFS, 1.0 RMS = 0 dB). Percentile levels
follow acoustics convention: L10 = level exceeded 10 % of the time (90th
percentile of frame levels), L90 = level exceeded 90 % of the time (background).
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta
from functools import lru_cache

import numpy as np

from .analysis import db
from .catalog import AudioFile, naive_epoch

RESOLUTIONS = [0.125, 1.0, 10.0, 60.0, 300.0]
MAX_POINTS = 150_000
METRICS = ("leq", "l10", "l50", "l90", "lmax", "anthro", "bio", "ndsi")


@dataclass
class Track:
    file: AudioFile
    e: dict  # z, a, anthro, bio -> float32 energies; frame_sec

    @property
    def frame_sec(self) -> float:
        return float(self.e["frame_sec"])

    @property
    def n(self) -> int:
        return len(self.e["z"])

    @property
    def length(self) -> float:
        return self.n * self.frame_sec

    @property
    def tod0(self) -> float:
        s = self.file.start
        return s.hour * 3600 + s.minute * 60 + s.second + s.microsecond / 1e6


def wkey(weighting: str) -> str:
    return "a" if weighting.upper() == "A" else "z"


def _ndsi(anthro_e, bio_e):
    with np.errstate(invalid="ignore", divide="ignore"):
        return (bio_e - anthro_e) / (bio_e + anthro_e)


def _blocks(x: np.ndarray, k: int):
    """Return (full (nb,k) view, partial tail or None)."""
    nf = len(x) // k
    full = x[: nf * k].reshape(nf, k)
    tail = x[nf * k:]
    return full, (tail if len(tail) else None)


def _bin_metric(x: np.ndarray, k: int, fn):
    full, tail = _blocks(x, k)
    out = fn(full, 1) if len(full) else np.zeros(0)
    if tail is not None:
        out = np.concatenate([out, fn(tail[None, :], 1)])
    return out


@lru_cache(maxsize=512)
def _bin_cached(track_key, res: float, weighting: str):
    track = _TRACKS[track_key]
    return bin_track(track, res, weighting)


_TRACKS: dict = {}


def register(track: Track) -> None:
    _TRACKS[track.file.id] = track
    _bin_cached.cache_clear()


def clear_registry() -> None:
    _TRACKS.clear()
    _bin_cached.cache_clear()


def bin_track(track: Track, res: float, weighting: str) -> dict:
    """Bin one file's frames into bins of `res` seconds (bins never cross files)."""
    fs = track.frame_sec
    k = max(1, int(round(res / fs)))
    w = track.e[wkey(weighting)].astype(np.float64)
    an = track.e["anthro"].astype(np.float64)
    bi = track.e["bio"].astype(np.float64)
    mean = lambda a, ax: a.mean(axis=ax)
    we, ae, be = (_bin_metric(v, k, mean) for v in (w, an, bi))
    nb = len(we)
    out = {
        "t": np.arange(nb) * k * fs,
        "leq": db(we),
        "anthro": db(ae),
        "bio": db(be),
        "ndsi": _ndsi(ae, be),
    }
    lv = db(w)
    out["lmax"] = _bin_metric(lv, k, lambda a, ax: a.max(axis=ax))
    if k > 1:
        pct = lambda a, ax: np.percentile(a, [90, 50, 10], axis=ax).T
        full, tail = _blocks(lv, k)
        p = pct(full, 1) if len(full) else np.zeros((0, 3))
        if tail is not None:
            p = np.vstack([p, pct(tail[None, :], 1)])
        out["l10"], out["l50"], out["l90"] = p[:, 0], p[:, 1], p[:, 2]
    else:
        out["l10"] = out["l50"] = out["l90"] = np.full(nb, np.nan)
    return out


def binned(track: Track, res: float, weighting: str) -> dict:
    register_if_needed(track)
    return _bin_cached(track.file.id, res, weighting.upper())


def register_if_needed(track: Track) -> None:
    if _TRACKS.get(track.file.id) is not track:
        register(track)


def _clean(a: np.ndarray, nd: int = 2) -> list:
    a = np.asarray(a, dtype=np.float64)
    r = np.round(a, nd).astype(object)
    r[~np.isfinite(a)] = None
    return r.tolist()


def segments(tracks: list[Track]) -> list[dict]:
    segs, off = [], 0.0
    for tr in tracks:
        segs.append({
            "file_id": tr.file.id, "name": tr.file.name, "day": tr.file.day,
            "place": tr.file.place,
            "x0": off, "x1": off + tr.length,
            "start_epoch": naive_epoch(tr.file.start),
        })
        off += tr.length
    return segs


def pick_res(span: float, res: float | None, target: int = 20_000) -> float:
    """Auto (res None): finest resolution with <= target points."""
    if res is None:
        for r in RESOLUTIONS:
            if span / r <= target:
                return r
        return RESOLUTIONS[-1]
    return res


def series(tracks: list[Track], res: float | None, weighting: str,
           x0: float | None = None, x1: float | None = None) -> dict:
    segs = segments(tracks)
    total = segs[-1]["x1"] if segs else 0.0
    lo = 0.0 if x0 is None else max(0.0, x0)
    hi = total if x1 is None else min(total, x1)
    span = max(hi - lo, 1.0)
    requested = res
    r = pick_res(span, res)
    coarsened = False
    while span / r > MAX_POINTS and r < RESOLUTIONS[-1]:
        r = next(x for x in RESOLUTIONS if x > r)
        coarsened = True

    cols = {m: [] for m in METRICS}
    xs = []
    for seg, tr in zip(segs, tracks):
        if seg["x1"] < lo or seg["x0"] > hi:
            continue
        b = binned(tr, r, weighting)
        x = seg["x0"] + b["t"]
        m = (x + r >= lo) & (x <= hi)
        if xs:  # null point -> line break at the file boundary
            xs.append(np.array([seg["x0"] - 1e-3]))
            for k in METRICS:
                cols[k].append(np.array([np.nan]))
        xs.append(x[m])
        for k in METRICS:
            cols[k].append(b[k][m])
    cat = lambda L: np.concatenate(L) if L else np.zeros(0)
    return {
        "res": r, "requested_res": requested, "coarsened": coarsened,
        "x": _clean(cat(xs), 3),
        **{k: _clean(cat(v), 3 if k == "ndsi" else 2) for k, v in cols.items()},
        "segments": segs, "total": total,
    }


def overlay(by_day: dict[str, list[Track]], res: float | None, weighting: str,
            metric: str) -> dict:
    """Each day as its own line on a shared time-of-day axis."""
    if metric not in METRICS:
        metric = "leq"
    # span of time of day covered
    tods = [(tr.tod0, tr.tod0 + tr.length) for trs in by_day.values() for tr in trs]
    span = (max(t[1] for t in tods) - min(t[0] for t in tods)) if tods else 1.0
    r = pick_res(span, res, target=8_000)
    while span / r * max(1, len(by_day)) > MAX_POINTS and r < RESOLUTIONS[-1]:
        r = next(x for x in RESOLUTIONS if x > r)
    per_day = {}
    for day, trs in by_day.items():
        d = {}
        for tr in trs:
            b = binned(tr, r, weighting)
            for x, v in zip(np.round(tr.tod0 + b["t"], 3), b[metric]):
                d[float(x)] = v
        per_day[day] = d
    grid = sorted(set().union(*[d.keys() for d in per_day.values()])) if per_day else []
    return {
        "res": r, "metric": metric, "x": grid, "days": list(per_day.keys()),
        "values": [_clean(np.array([d.get(x, np.nan) for x in grid], dtype=float),
                          3 if metric == "ndsi" else 2) for d in per_day.values()],
    }


def _stats(w, an, bi, fs, threshold):
    lv = db(w)
    l10, l50, l90 = np.percentile(lv, [90, 50, 10]) if len(lv) else (np.nan,) * 3
    ae, be = an.mean(), bi.mean()
    row = {
        "leq": float(db(w.mean())), "l10": float(l10), "l50": float(l50),
        "l90": float(l90), "lmax": float(lv.max()), "anthro": float(db(ae)),
        "bio": float(db(be)), "ndsi": float(_ndsi(ae, be)),
        "duration": len(w) * fs,
    }
    if threshold is not None:
        k = max(1, int(round(1.0 / fs)))
        sec = db(_bin_metric(w, k, lambda a, ax: a.mean(axis=ax)))
        row["pct_above"] = float((sec > threshold).mean() * 100) if len(sec) else 0.0
    return row


def summary(groups, weighting: str, threshold: float | None = None) -> list[dict]:
    """groups: list of (label, place, tracks) - or a {label: tracks} dict.
    `place` is None when a group spans several places."""
    if isinstance(groups, dict):
        groups = [(k, _common_place(v), v) for k, v in groups.items()]
    rows = []
    for label, place, trs in groups:
        if not trs:
            continue
        cat = lambda key: np.concatenate([t.e[key].astype(np.float64) for t in trs])
        row = _stats(cat(wkey(weighting)), cat("anthro"), cat("bio"),
                     trs[0].frame_sec, threshold)
        row.update({"label": label, "place": place, "files": len(trs),
                    "file_ids": [t.file.id for t in trs],
                    "start": trs[0].file.start.isoformat(), "day": trs[0].file.day})
        rows.append({k: (None if isinstance(v, float) and not math.isfinite(v) else
                         (round(v, 3) if isinstance(v, float) else v))
                     for k, v in row.items()})
    return rows


def _common_place(trs: list[Track]):
    ps = {t.file.place for t in trs}
    return ps.pop() if len(ps) == 1 else None


def heatmap(rows, weighting: str, metric: str, slot: float = 300.0) -> dict:
    """Rows x time-of-day slots grid of `metric`.

    rows: {day: tracks} (classic day rows) or a list of dicts
    {"label", "place", "day", "tracks"}. A row with tracks from several days
    pools all their frames per slot (a 'typical day')."""
    if isinstance(rows, dict):
        rows = [{"label": d, "place": _common_place(t), "day": d, "tracks": t}
                for d, t in rows.items()]
    wk = wkey(weighting)
    cells: dict[tuple[int, int], list] = {}
    for ri, row in enumerate(rows):
        for tr in row["tracks"]:
            fs = tr.frame_sec
            tod = tr.tod0 + np.arange(tr.n) * fs
            sl = (tod // slot).astype(int)
            bounds = np.flatnonzero(np.diff(sl)) + 1
            for a, b in zip(np.r_[0, bounds], np.r_[bounds, tr.n]):
                cells.setdefault((ri, int(sl[a])), []).append((tr, a, b))
    slots = sorted({s for (_, s) in cells})
    grid = np.full((len(rows), len(slots)), np.nan)
    sidx = {s: i for i, s in enumerate(slots)}
    for (ri, s), parts in cells.items():
        g = lambda key: np.concatenate([t.e[key][a:b].astype(np.float64) for t, a, b in parts])
        w = g(wk)
        if metric in ("leq",):
            v = db(w.mean())
        elif metric in ("l10", "l50", "l90"):
            v = np.percentile(db(w), {"l10": 90, "l50": 50, "l90": 10}[metric])
        elif metric == "lmax":
            v = db(w).max()
        elif metric == "anthro":
            v = db(g("anthro").mean())
        elif metric == "bio":
            v = db(g("bio").mean())
        else:  # ndsi
            v = _ndsi(g("anthro").mean(), g("bio").mean())
        grid[ri, sidx[s]] = v
    return {
        "rows": [{"label": r["label"], "place": r.get("place"), "day": r.get("day")} for r in rows],
        "days": [r["label"] for r in rows],  # backwards compatible alias
        "slot": slot, "slots": [s * slot for s in slots],
        "metric": metric, "values": [_clean(row, 3 if metric == "ndsi" else 2) for row in grid],
    }


def events(tracks: list[Track], weighting: str, n: int = 20, min_sep: float = 15.0) -> list[dict]:
    """Loudest 1-second Leq bins in scope, separated by >= min_sep seconds."""
    segs = segments(tracks)
    cand = []
    for seg, tr in zip(segs, tracks):
        b = binned(tr, 1.0, weighting)
        lv = b["leq"]
        if not len(lv):
            continue
        top = np.argsort(lv)[::-1][: n * 20]
        for i in top:
            cand.append((float(lv[i]), seg, tr, float(b["t"][i])))
    cand.sort(key=lambda c: c[0], reverse=True)
    chosen = []
    for lv, seg, tr, t in cand:
        x = seg["x0"] + t
        if any(abs(x - c["x"]) < min_sep for c in chosen):
            continue
        chosen.append({
            "level": round(lv, 2), "x": x, "file_id": tr.file.id, "name": tr.file.name,
            "place": tr.file.place,
            "offset": t, "clock_epoch": seg["start_epoch"] + t,
        })
        if len(chosen) >= n:
            break
    return chosen


# ---------------------------------------------------------------- places side by side
def _epoch_day(epoch: float) -> str:
    return (datetime(1970, 1, 1) + timedelta(seconds=epoch)).strftime("%Y-%m-%d")


def shared_segments(tracks: list[Track], tol: float = 1.0) -> list[dict]:
    """Merge the recording intervals of all tracks (any place) and lay them end to
    end, giving one clock-time axis that parallel recorders can share."""
    ivs = sorted((naive_epoch(t.file.start), naive_epoch(t.file.start) + t.length) for t in tracks)
    merged: list[list[float]] = []
    for a, b in ivs:
        if merged and a <= merged[-1][1] + tol:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    segs, off = [], 0.0
    for a, b in merged:
        segs.append({"file_id": None, "name": "", "place": None, "day": _epoch_day(a),
                     "x0": off, "x1": off + (b - a), "start_epoch": a})
        off += b - a
    return segs


def compare(by_place: dict[str, list[Track]], res: float | None, weighting: str,
            metric: str = "leq", x0: float | None = None, x1: float | None = None) -> dict:
    """One series per place on a shared (concatenated clock-time) axis."""
    if metric not in METRICS:
        metric = "leq"
    places = [p for p, trs in by_place.items() if trs]
    allt = [t for p in places for t in by_place[p]]
    segs = shared_segments(allt)
    total = segs[-1]["x1"] if segs else 0.0
    lo = 0.0 if x0 is None else max(0.0, x0)
    hi = total if x1 is None else min(total, x1)
    span = max(hi - lo, 1.0)
    requested = res
    r = pick_res(span, res)
    coarsened = False
    while span / r * max(1, len(places)) > MAX_POINTS and r < RESOLUTIONS[-1]:
        r = next(x for x in RESOLUTIONS if x > r)
        coarsened = True
    starts = [s["start_epoch"] for s in segs]

    def to_x(epoch: np.ndarray) -> np.ndarray:
        i = np.clip(np.searchsorted(starts, epoch + 1e-6, side="right") - 1, 0, len(segs) - 1)
        s0 = np.array([segs[k]["start_epoch"] for k in i])
        sx = np.array([segs[k]["x0"] for k in i])
        return sx + (epoch - s0)

    per_place: list[tuple[np.ndarray, np.ndarray]] = []
    for p in places:
        idxs, vals = [], []
        for tr in by_place[p]:
            e0 = naive_epoch(tr.file.start)
            sx = to_x(np.array([e0]))[0]
            if sx > hi or sx + tr.length < lo:
                continue
            b = binned(tr, r, weighting)
            x = to_x(e0 + b["t"])
            m = (x + r >= lo) & (x <= hi)
            idxs.append(np.floor(x[m] / r + 0.5).astype(np.int64))  # snap to shared grid
            vals.append(b[metric][m])
        cat = lambda L, dt: np.concatenate(L) if L else np.zeros(0, dt)
        per_place.append((cat(idxs, np.int64), cat(vals, np.float64)))
    grid = np.unique(np.concatenate([i for i, _ in per_place])) if per_place else np.zeros(0, np.int64)
    xs = grid * r
    values = []
    for idx, v in per_place:
        col = np.full(len(grid), np.nan)
        col[np.searchsorted(grid, idx)] = v
        values.append(col)
    # null points at shared-segment boundaries so lines break between recordings
    brk = np.array([s["x0"] - 1e-3 for s in segs[1:] if lo < s["x0"] <= hi])
    if len(brk):
        order = np.argsort(np.concatenate([xs, brk]), kind="stable")
        xs = np.concatenate([xs, brk])[order]
        values = [np.concatenate([v, np.full(len(brk), np.nan)])[order] for v in values]
    nd = 3 if metric == "ndsi" else 2
    return {
        "res": r, "requested_res": requested, "coarsened": coarsened, "metric": metric,
        "x": _clean(xs, 3), "places": places, "values": [_clean(v, nd) for v in values],
        "segments": segs, "total": total,
    }
