"""Scan a folder for audio files and determine each file's start time."""
from __future__ import annotations

import hashlib
import os
import re
from dataclasses import dataclass, asdict
from datetime import datetime

import soundfile as sf

AUDIO_EXT = {".wav", ".flac", ".mp3", ".ogg", ".aif", ".aiff"}
NAME_TS = re.compile(r"(\d{8})[_T-](\d{6})")
GUANO_TS = re.compile(rb"Timestamp:\s*(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})")


@dataclass
class AudioFile:
    id: str
    path: str
    name: str
    start: datetime  # naive local recorder time
    start_source: str  # filename | guano | mtime
    duration: float
    samplerate: int
    channels: int
    size: int
    mtime: float
    place: str = ""

    @property
    def day(self) -> str:
        return self.start.strftime("%Y-%m-%d")

    def to_json(self) -> dict:
        d = asdict(self)
        d.pop("path")
        d["start"] = self.start.isoformat()
        d["start_epoch"] = naive_epoch(self.start)
        d["day"] = self.day
        return d


def naive_epoch(dt: datetime) -> float:
    """Seconds since 1970 treating the naive time as UTC (UI formats in UTC)."""
    return (dt - datetime(1970, 1, 1)).total_seconds()


def _guano_start(path: str) -> datetime | None:
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as fh:
            fh.seek(max(0, size - 65536))
            tail = fh.read()
        m = GUANO_TS.search(tail)
        if m:
            return datetime.fromisoformat(m.group(1).decode().replace(" ", "T"))
    except (OSError, ValueError):
        pass
    return None


def start_time(path: str) -> tuple[datetime, str]:
    m = NAME_TS.search(os.path.basename(path))
    if m:
        try:
            return datetime.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M%S"), "filename"
        except ValueError:
            pass
    g = _guano_start(path)
    if g:
        return g, "guano"
    return datetime.fromtimestamp(os.path.getmtime(path)), "mtime"


def file_id(path: str) -> str:
    return hashlib.sha1(os.path.abspath(path).encode()).hexdigest()[:12]


def place_of(root: str, path: str) -> str:
    """Place = first sub-folder below the loaded root. Files directly in the root, or
    in a recorder 'Data' folder right below it, belong to the root itself."""
    root = os.path.abspath(root)
    rel = os.path.relpath(os.path.dirname(os.path.abspath(path)), root)
    first = rel.split(os.sep)[0]
    if rel == "." or first.lower() == "data":
        return os.path.basename(root.rstrip(os.sep)) or root
    return first


def scan(folder: str) -> list[AudioFile]:
    files: list[AudioFile] = []
    for root, dirs, names in os.walk(folder):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for n in names:
            if n.startswith(".") or os.path.splitext(n)[1].lower() not in AUDIO_EXT:
                continue
            p = os.path.join(root, n)
            try:
                info = sf.info(p)
            except Exception:
                continue
            st = os.stat(p)
            start, src = start_time(p)
            files.append(AudioFile(
                id=file_id(p), path=p, name=os.path.relpath(p, folder), start=start,
                start_source=src, duration=float(info.duration),
                samplerate=int(info.samplerate), channels=int(info.channels),
                size=st.st_size, mtime=st.st_mtime, place=place_of(folder, p),
            ))
    files.sort(key=lambda f: (f.place, f.start, f.name))
    return files
