"""On-disk cache of per-file analysis results and small settings."""
from __future__ import annotations

import hashlib
import json
import os

import numpy as np

CACHE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "cache")
CACHE_VERSION = "v2"
SETTINGS = os.path.join(CACHE_DIR, "settings.json")


def _bands_tag(bands: dict | None) -> str:
    if not bands:
        return "default"
    return ";".join(f"{k}={float(v[0]):g}-{float(v[1]):g}" for k, v in sorted(bands.items()))


def _key(path: str, size: int, mtime: float, bands: dict | None = None) -> str:
    raw = f"{CACHE_VERSION}|{os.path.abspath(path)}|{size}|{mtime:.3f}|{_bands_tag(bands)}"
    return hashlib.sha1(raw.encode()).hexdigest()


def cache_path(path: str, size: int, mtime: float, bands: dict | None = None) -> str:
    return os.path.join(CACHE_DIR, _key(path, size, mtime, bands) + ".npz")


def load(path: str, size: int, mtime: float, bands: dict | None = None) -> dict | None:
    p = cache_path(path, size, mtime, bands)
    if not os.path.exists(p):
        return None
    try:
        with np.load(p) as d:
            return {k: d[k] for k in d.files}
    except Exception:
        return None


def save(path: str, size: int, mtime: float, data: dict, bands: dict | None = None) -> None:
    os.makedirs(CACHE_DIR, exist_ok=True)
    p = cache_path(path, size, mtime, bands)
    tmp = p + ".tmp.npz"
    np.savez_compressed(tmp, **data)
    os.replace(tmp, p)


def read_settings() -> dict:
    try:
        with open(SETTINGS) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def write_settings(**kw) -> None:
    s = read_settings()
    s.update(kw)
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(SETTINGS, "w") as fh:
        json.dump(s, fh, indent=2)
