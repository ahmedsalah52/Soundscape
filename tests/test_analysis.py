from datetime import datetime

import numpy as np
import pytest

from app import aggregate as agg
from app.analysis import analyze_array, db
from app.catalog import AudioFile, start_time

FS = 44100


def tone(freq, amp=0.5, sec=10.0):
    t = np.arange(int(FS * sec)) / FS
    return amp * np.sin(2 * np.pi * freq * t)


def leq(e, skip=8):  # skip first second (filter settling)
    return float(db(e[skip:].mean()))


def test_1khz_sine_levels():
    r = analyze_array(tone(1000), FS)
    expected = 20 * np.log10(0.5 / np.sqrt(2))  # -9.03 dB
    assert leq(r["z"]) == pytest.approx(expected, abs=0.1)
    assert leq(r["a"]) == pytest.approx(expected, abs=0.1)


def test_a_weighting_100hz():
    r = analyze_array(tone(100), FS)
    assert leq(r["a"]) - leq(r["z"]) == pytest.approx(-19.1, abs=0.3)


def test_bands_and_ndsi():
    r = analyze_array(tone(1500), FS)
    a, b = r["anthro"][8:].mean(), r["bio"][8:].mean()
    assert db(a) == pytest.approx(leq(r["z"]), abs=0.5)
    assert (b - a) / (b + a) < -0.95
    r = analyze_array(tone(5000), FS)
    a, b = r["anthro"][8:].mean(), r["bio"][8:].mean()
    assert (b - a) / (b + a) > 0.95


def _track(energies, start=datetime(2026, 4, 16, 3, 0, 0), fid="x"):
    e = {k: np.asarray(energies, dtype=np.float32) for k in ("z", "a", "anthro", "bio")}
    e["frame_sec"] = np.float64(0.125)
    f = AudioFile(fid, "/x.wav", "x.wav", start, "filename", len(energies) * 0.125,
                  FS, 1, 0, 0.0)
    return agg.Track(f, e)


def test_energy_rebinning():
    rng = np.random.default_rng(0)
    e = rng.uniform(1e-6, 1e-2, 480 * 3 + 5)  # 3 minutes + partial tail
    tr = _track(e)
    b1 = agg.bin_track(tr, 1.0, "Z")
    b60 = agg.bin_track(tr, 60.0, "Z")
    e32 = e.astype(np.float32).astype(np.float64)
    assert b60["leq"][0] == pytest.approx(db(e32[:480].mean()), abs=1e-6)
    # 1 s -> 1 min via energy averaging matches direct 1 min binning
    from_1s = db((10 ** (b1["leq"][:60] / 10)).mean())
    assert from_1s == pytest.approx(b60["leq"][0], abs=1e-4)
    assert len(b60["leq"]) == 4  # tail bin kept


def test_percentiles_on_known_data():
    lv = np.arange(1, 101, dtype=float)  # levels 1..100 dB, 100 frames
    tr = _track(10 ** ((lv - 100) / 10))
    b = agg.bin_track(tr, 12.5, "Z")  # exactly 100 frames
    assert b["l10"][0] == pytest.approx(np.percentile(lv - 100, 90), abs=1e-3)
    assert b["l90"][0] == pytest.approx(np.percentile(lv - 100, 10), abs=1e-3)
    assert b["lmax"][0] == pytest.approx(0.0, abs=1e-3)


def test_series_concat_and_segments():
    t1 = _track(np.full(80, 1e-4), fid="a")
    t2 = _track(np.full(80, 1e-2), start=datetime(2026, 4, 16, 3, 0, 10), fid="b")
    s = agg.series([t1, t2], 1.0, "Z")
    assert [g["x0"] for g in s["segments"]] == [0.0, 10.0]
    assert None in s["leq"]  # null separator between files
    vals = [v for v in s["leq"] if v is not None]
    assert vals[0] == pytest.approx(-40) and vals[-1] == pytest.approx(-20)


def test_start_time_from_filename():
    dt, src = start_time("/d/SMM07134_20260416_032959.wav")
    assert src == "filename" and dt == datetime(2026, 4, 16, 3, 29, 59)


def test_custom_bands():
    r = analyze_array(tone(500), FS, {"anthro": (50, 1000), "bio": (1000, 11000)})
    assert db(r["anthro"][8:].mean()) == pytest.approx(leq(r["z"]), abs=0.5)
    assert r["bio"][8:].mean() < r["anthro"][8:].mean() * 1e-3


def test_spectrum_overview_peak():
    r = analyze_array(tone(3000), FS)
    edges = r["spec_edges"]
    row = int(np.argmax(r["spec"][2].astype(float)))
    assert edges[row] <= 3000 < edges[row + 1]
    assert r["spec"].shape[0] == 10  # 10 s of audio -> 10 per-second rows


def test_spectrogram_detail_and_overview(tmp_path):
    import base64
    import soundfile as sf
    from app.analysis import analyze_file
    from app.spectro import spectrogram

    x = np.concatenate([tone(800, sec=20), tone(5000, sec=20)])
    p = tmp_path / "REC_20260416_030000.wav"
    sf.write(p, x.astype(np.float32), FS)
    f = AudioFile("t", str(p), p.name, datetime(2026, 4, 16, 3), "filename", 40.0, FS, 1, 0, 0.0)
    tr = agg.Track(f, analyze_file(str(p)))

    def peak_freq(sp, col):
        q = np.frombuffer(base64.b64decode(sp["data"]), np.uint8).reshape(sp["rows"], sp["cols"])
        r = int(np.argmax(q[:, col]))
        return sp["edges"][r], sp["edges"][r + 1]

    sp = spectrogram([tr], 0, 40, 200)
    assert sp["mode"] == "detail"
    lo, hi = peak_freq(sp, 50)        # t = 10 s -> 800 Hz
    assert lo <= 800 < hi * 1.05
    lo, hi = peak_freq(sp, 150)       # t = 30 s -> 5 kHz
    assert lo <= 5000 < hi * 1.05

    import app.spectro as spm
    old = spm.DETAIL_MAX_SPAN
    spm.DETAIL_MAX_SPAN = 1
    try:
        sp = spectrogram([tr], 0, 40, 100)
    finally:
        spm.DETAIL_MAX_SPAN = old
    assert sp["mode"] == "overview"
    lo, hi = peak_freq(sp, 75)
    assert lo <= 5000 < hi
