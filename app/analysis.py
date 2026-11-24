"""Per-file DSP: turn an audio file into 125 ms frame energies + a spectrum overview.

For each 125 ms frame we store the *mean-square* value (energy, not dB) of
  z      - the unweighted (Z) signal
  a      - the A-weighted signal (IEC 61672 curve, bilinear transform)
  anthro - anthrophony band (default 1-2 kHz, Kasten et al. NDSI convention)
  bio    - biophony band    (default 2-11 kHz)
Keeping energies lets every later aggregation be energy-correct
(Leq = 10*log10(mean energy)), never an average of dB values.

Additionally a per-second spectrum overview in 1/6-octave rows (power spectral
density, dB re 1 FS^2/Hz, float16) is stored for the long-span spectrogram.
"""
from __future__ import annotations

import numpy as np
import soundfile as sf
from scipy import signal

FRAME_SEC = 0.125
BLOCK_FRAMES = 480  # 480 * 125 ms = 60 s per read block
DEFAULT_BANDS = {"anthro": (1000.0, 2000.0), "bio": (2000.0, 11000.0)}
CHANNELS = ("z", "a", "anthro", "bio")
SPEC_FMIN = 20.0


def a_weighting_sos(fs: float) -> np.ndarray:
    """Digital A-weighting filter (SOS), normalised to 0 dB at 1 kHz."""
    f1, f2, f3, f4 = 20.598997, 107.65265, 737.86223, 12194.217
    z = [0.0, 0.0, 0.0, 0.0]
    p = [-2 * np.pi * f for f in (f1, f1, f2, f3, f4, f4)]
    zd, pd, kd = signal.bilinear_zpk(z, p, 1.0, fs)
    _, h = signal.freqz_zpk(zd, pd, kd, worN=[1000.0], fs=fs)
    kd = kd / abs(h[0])
    return signal.zpk2sos(zd, pd, kd)


def log_edges(fs: float, per_octave: int) -> np.ndarray:
    n = int(np.floor(np.log2((fs / 2) / SPEC_FMIN) * per_octave))
    e = SPEC_FMIN * 2.0 ** (np.arange(n + 1) / per_octave)
    return np.append(e, fs / 2) if e[-1] < fs / 2 * 0.999 else e


def row_matrix(freqs: np.ndarray, edges: np.ndarray) -> np.ndarray:
    """(F x R) matrix averaging FFT-bin densities into rows [edges[r], edges[r+1]).
    Rows narrower than the bin spacing take the nearest bin."""
    R = len(edges) - 1
    M = np.zeros((len(freqs), R))
    idx = np.searchsorted(edges, freqs, side="right") - 1
    for r in range(R):
        sel = np.flatnonzero(idx == r)
        if len(sel):
            M[sel, r] = 1.0 / len(sel)
        else:
            c = np.sqrt(edges[r] * edges[r + 1])
            M[np.argmin(np.abs(freqs - c)), r] = 1.0
    return M


def normalize_bands(bands: dict | None) -> dict:
    b = dict(DEFAULT_BANDS)
    for k in ("anthro", "bio"):
        if bands and k in bands:
            lo, hi = float(bands[k][0]), float(bands[k][1])
            if not (0 <= lo < hi):
                raise ValueError(f"bad {k} band {lo}-{hi}")
            b[k] = (lo, hi)
    return b


class FrameAnalyzer:
    """Streaming analyzer: feed blocks (length = multiple of frame size)."""

    def __init__(self, fs: float, bands: dict | None = None):
        self.fs = fs
        self.frame = int(round(FRAME_SEC * fs))
        self.filters = {"a": a_weighting_sos(fs)}
        bands = normalize_bands(bands)
        # band energies via per-frame Hann FFT (sharp band edges, as in NDSI)
        self.win = np.hanning(self.frame)
        freqs = np.fft.rfftfreq(self.frame, 1.0 / fs)
        self.masks = {k: (freqs >= lo) & (freqs < min(hi, 0.5 * fs + 1)) for k, (lo, hi) in bands.items()}
        # one-sided power -> mean-square, corrected for the window's power
        self.pscale = 2.0 / (self.frame * np.sum(self.win ** 2))
        self.df = fs / self.frame
        self.spec_edges = log_edges(fs, 6)
        self.spec_M = row_matrix(freqs, self.spec_edges)
        self.state = {k: np.zeros((sos.shape[0], 2)) for k, sos in self.filters.items()}
        self.out: dict[str, list[np.ndarray]] = {k: [] for k in CHANNELS}
        self.spec: list[np.ndarray] = []

    def _ms(self, x: np.ndarray) -> np.ndarray:
        n = len(x) // self.frame
        f = x[: n * self.frame].reshape(n, self.frame)
        return np.einsum("ij,ij->i", f, f) / self.frame

    def feed(self, x: np.ndarray) -> None:
        x = np.asarray(x, dtype=np.float64)
        self.out["z"].append(self._ms(x))
        for k, sos in self.filters.items():
            y, self.state[k] = signal.sosfilt(sos, x, zi=self.state[k])
            self.out[k].append(self._ms(y))
        n = len(x) // self.frame
        if n:
            frames = x[: n * self.frame].reshape(n, self.frame) * self.win
            spec = np.fft.rfft(frames, axis=1)
            p = (spec.real ** 2 + spec.imag ** 2) * self.pscale
            for k, m in self.masks.items():
                self.out[k].append(p[:, m].sum(axis=1))
            self.spec.append((p / self.df) @ self.spec_M)

    def result(self) -> dict[str, np.ndarray]:
        res = {
            k: (np.concatenate(v) if v else np.zeros(0)).astype(np.float32)
            for k, v in self.out.items()
        }
        k = max(1, int(round(1.0 / (self.frame / self.fs))))
        S = np.concatenate(self.spec) if self.spec else np.zeros((0, len(self.spec_edges) - 1))
        nsec = len(S) // k
        per_sec = S[: nsec * k].reshape(nsec, k, -1).mean(axis=1)
        res["spec"] = db(per_sec, 1e-20).astype(np.float16)
        res["spec_sec"] = np.float64(k * self.frame / self.fs)
        res["spec_edges"] = self.spec_edges.astype(np.float32)
        return res


def analyze_array(x: np.ndarray, fs: float, bands: dict | None = None) -> dict[str, np.ndarray]:
    an = FrameAnalyzer(fs, bands)
    step = an.frame * BLOCK_FRAMES
    for i in range(0, len(x), step):
        an.feed(x[i : i + step])
    return an.result()


def analyze_file(path: str, bands: dict | None = None) -> dict:
    """Analyze an audio file; returns energies + metadata (picklable)."""
    with sf.SoundFile(path) as f:
        fs = f.samplerate
        an = FrameAnalyzer(fs, bands)
        step = an.frame * BLOCK_FRAMES
        while True:
            block = f.read(step, dtype="float32", always_2d=True)
            if len(block) == 0:
                break
            an.feed(block.mean(axis=1) if block.shape[1] > 1 else block[:, 0])
            if len(block) < step:
                break
    res = an.result()
    res["fs"] = np.float64(fs)
    res["frame_sec"] = np.float64(an.frame / fs)
    return res


def db(energy, floor: float = 1e-12):
    return 10.0 * np.log10(np.maximum(energy, floor))
