"""Place level: folder layout detection, side-by-side comparison, place rows."""
from datetime import datetime

import numpy as np
import pytest
import soundfile as sf

from app import aggregate as agg
from app.analysis import db
from app.catalog import AudioFile, scan

FS = 8000


def _wav(path, sec=2.0):
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(path, np.zeros(int(FS * sec), np.float32), FS)


def test_scan_parent_with_places(tmp_path):
    _wav(tmp_path / "SMM1_Reitstall" / "Data" / "SMM1_20260416_030000.wav")
    _wav(tmp_path / "SMM2_Wald" / "Data" / "SMM2_20260416_030000.wav")
    _wav(tmp_path / "SMM2_Wald" / "Data" / "SMM2_20260417_030000.wav")
    files = scan(str(tmp_path))
    assert [f.place for f in files] == ["SMM1_Reitstall", "SMM2_Wald", "SMM2_Wald"]


def test_scan_single_place_folder(tmp_path):
    root = tmp_path / "SMM1_Reitstall"
    _wav(root / "Data" / "SMM1_20260416_030000.wav")
    assert {f.place for f in scan(str(root))} == {"SMM1_Reitstall"}


def test_scan_flat_folder(tmp_path):
    root = tmp_path / "flat"
    _wav(root / "REC_20260416_030000.wav")
    assert {f.place for f in scan(str(root))} == {"flat"}


def _track(level_db, start, place, fid, n=80):
    e = {k: np.full(n, 10 ** (level_db / 10), np.float32) for k in ("z", "a", "anthro", "bio")}
    e["frame_sec"] = np.float64(0.125)
    f = AudioFile(fid, "/x.wav", f"{fid}.wav", start, "filename", n * 0.125, FS, 1, 0, 0.0, place)
    return agg.Track(f, e)


def test_compare_aligns_parallel_places():
    d = datetime(2026, 4, 16, 3, 0, 0)
    a = [_track(-40, d, "A", "a1"), _track(-40, datetime(2026, 4, 17, 3), "A", "a2")]
    # B starts 0.5 s later on day 1 (clock skew) and is 6 dB louder
    b = [_track(-34, datetime(2026, 4, 16, 3, 0, 0, 500000), "B", "b1")]
    c = agg.compare({"A": a, "B": b}, 1.0, "Z")
    assert c["places"] == ["A", "B"]
    assert len(c["segments"]) == 2                      # two merged recording intervals
    assert c["segments"][0]["x1"] == pytest.approx(10.5)
    va, vb = (np.array([np.nan if v is None else v for v in col]) for col in c["values"])
    both = ~np.isnan(va) & ~np.isnan(vb)
    assert both.sum() >= 8                              # aligned on one grid despite skew
    assert np.allclose(vb[both] - va[both], 6.0, atol=1e-3)
    assert np.isnan(vb[np.array(c["x"]) > 11]).all()   # B has no day 2
    assert None in c["values"][0]                      # break between recordings


def test_heatmap_place_rows_pool_days():
    a1 = _track(-40, datetime(2026, 4, 16, 3), "A", "a1")
    a2 = _track(-30, datetime(2026, 4, 17, 3), "A", "a2")
    hm = agg.heatmap([{"label": "A", "place": "A", "day": None, "tracks": [a1, a2]}], "Z", "leq", 300)
    expected = float(db((10 ** -4 + 10 ** -3) / 2))
    assert hm["rows"][0]["place"] == "A"
    assert hm["values"][0][0] == pytest.approx(expected, abs=0.01)


def test_summary_and_events_carry_place():
    a = _track(-40, datetime(2026, 4, 16, 3), "A", "a1")
    b = _track(-20, datetime(2026, 4, 16, 3), "B", "b1")
    rows = agg.summary([("A", "A", [a]), ("B", "B", [b])], "Z")
    assert [r["place"] for r in rows] == ["A", "B"]
    assert rows[1]["leq"] - rows[0]["leq"] == pytest.approx(20, abs=1e-3)
    ev = agg.events([a, b], "Z", n=1)
    assert ev[0]["place"] == "B"
