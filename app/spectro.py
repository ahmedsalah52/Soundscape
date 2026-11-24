"""Spectrogram data for a concatenated time range.

Two levels of detail, both returned on a uniform column grid over [x0, x1]:
  overview - from the per-second 1/6-octave spectra saved during analysis
  detail   - STFT computed from the audio itself (span <= DETAIL_MAX_SPAN)
Values are power spectral density in dB re 1 FS^2/Hz, quantised to uint8.
"""
from __future__ import annotations

import base64

import numpy as np
import soundfile as sf
from scipy import fft as sfft

from .aggregate import Track, segments
from .analysis import db, log_edges, row_matrix

DETAIL_MAX_SPAN = 600.0  # seconds
NFFT = 2048


def _accumulate(out_sum, out_cnt, cols, rows_energy):
    """Add rows_energy[i] into column cols[i] (cols non-decreasing)."""
    ok = (cols >= 0) & (cols < len(out_sum))
    cols, rows_energy = cols[ok], rows_energy[ok]
    if not len(cols):
        return
    starts = np.flatnonzero(np.r_[True, np.diff(cols) != 0])
    sums = np.add.reduceat(rows_energy, starts, axis=0)
    u = cols[starts]
    out_sum[u] += sums
    out_cnt[u] += np.diff(np.r_[starts, len(cols)])


def _overview(tracks, segs, x0, x1, ncols):
    edges = tracks[0].e["spec_edges"].astype(np.float64)
    R = len(edges) - 1
    colw = (x1 - x0) / ncols
    S, C = np.zeros((ncols, R)), np.zeros(ncols)
    for seg, tr in zip(segs, tracks):
        if seg["x1"] < x0 or seg["x0"] > x1 or "spec" not in tr.e:
            continue
        spec = tr.e["spec"].astype(np.float64)
        if spec.shape[1] != R:
            continue
        ss = float(tr.e["spec_sec"])
        xs = seg["x0"] + (np.arange(len(spec)) + 0.5) * ss
        cols = np.floor((xs - x0) / colw).astype(int)
        _accumulate(S, C, cols, 10 ** (spec / 10))
        # columns narrower than one second: fill from the covering second
        if colw < ss:
            cx = x0 + (np.arange(ncols) + 0.5) * colw
            i = np.floor((cx - seg["x0"]) / ss).astype(int)
            m = (cx >= seg["x0"]) & (cx < seg["x1"]) & (i >= 0) & (i < len(spec)) & (C == 0)
            S[m] = 10 ** (spec[i[m]] / 10)
            C[m] = 1
    return S, C, edges


def _detail(tracks, segs, x0, x1, ncols):
    fs = tracks[0].file.samplerate
    edges = log_edges(fs, 24)
    freqs = np.fft.rfftfreq(NFFT, 1.0 / fs)
    M = row_matrix(freqs, edges)
    win = np.hanning(NFFT).astype(np.float32)
    scale = 2.0 / (fs * np.sum(win.astype(np.float64) ** 2))
    hop = NFFT // 2
    colw = (x1 - x0) / ncols
    S, C = np.zeros((ncols, len(edges) - 1)), np.zeros(ncols)
    for seg, tr in zip(segs, tracks):
        a, b = max(x0, seg["x0"]), min(x1, seg["x1"])
        if b <= a:
            continue
        s0 = max(0, int((a - seg["x0"]) * fs) - NFFT // 2)
        s1 = int((b - seg["x0"]) * fs) + NFFT // 2
        with sf.SoundFile(tr.file.path) as f:
            f.seek(min(s0, f.frames))
            x = f.read(max(0, s1 - s0), dtype="float32", always_2d=True)
        x = x.mean(axis=1) if x.shape[1] > 1 else x[:, 0]
        if len(x) < NFFT:
            continue
        nwin = (len(x) - NFFT) // hop + 1
        for c0 in range(0, nwin, 4096):  # chunk to bound memory
            c1 = min(nwin, c0 + 4096)
            idx = (np.arange(c0, c1) * hop)[:, None] + np.arange(NFFT)[None, :]
            X = sfft.rfft(x[idx] * win, axis=1)
            P = (X.real ** 2 + X.imag ** 2) * scale  # PSD per window
            rows = P @ M
            t = seg["x0"] + (s0 + np.arange(c0, c1) * hop + NFFT / 2) / fs
            cols = np.floor((t - x0) / colw).astype(int)
            _accumulate(S, C, cols, rows)
    return S, C, edges


def spectrogram(tracks: list[Track], x0: float | None, x1: float | None, ncols: int) -> dict:
    segs = segments(tracks)
    total = segs[-1]["x1"] if segs else 0.0
    x0 = 0.0 if x0 is None else max(0.0, x0)
    x1 = total if x1 is None else min(total, x1)
    ncols = int(max(50, min(ncols, 3000)))
    if x1 <= x0:
        x1 = x0 + 1
    mode = "detail" if x1 - x0 <= DETAIL_MAX_SPAN else "overview"
    S, C, edges = (_detail if mode == "detail" else _overview)(tracks, segs, x0, x1, ncols)
    with np.errstate(invalid="ignore", divide="ignore"):
        D = db(S / np.maximum(C, 1)[:, None], 1e-20)
    D[C == 0] = np.nan
    fin = D[np.isfinite(D)]
    vmin, vmax = (float(np.percentile(fin, 0.5)), float(fin.max())) if len(fin) else (-120.0, -40.0)
    if vmax - vmin < 1:
        vmax = vmin + 1
    q = np.clip(np.round(1 + (D - vmin) / (vmax - vmin) * 254), 1, 255)
    q[~np.isfinite(D)] = 0
    return {
        "mode": mode, "x0": x0, "x1": x1, "cols": ncols, "rows": len(edges) - 1,
        "edges": [round(float(e), 2) for e in edges],
        "vmin": round(vmin, 2), "vmax": round(vmax, 2),
        "data": base64.b64encode(q.astype(np.uint8).T.copy().tobytes()).decode(),  # row-major: rows x cols
        "detail_max_span": DETAIL_MAX_SPAN,
    }
