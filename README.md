# Soundscape Loudness Panel

A local, lightweight panel for finding **when and where an area is loud**, built for
passive acoustic recordings such as Song Meter recordings.

**Double-click to start.** You need Python 3.9 or newer. The first run creates `.venv` and installs dependencies.
- **macOS:** double-click `run.command`. The first time only, macOS may say it "cannot be opened
  because it is from an unidentified developer". If so, right-click `run.command` → **Open** → **Open**.
  After that, double-clicking works. (Or run `xattr -d com.apple.quarantine run.command` once.)
- **Windows:** double-click `run.bat`. The native "Open folder…" dialog and drag-and-drop folder
  lookup work only on macOS. On Windows, paste the folder path instead.
- **Linux / terminal:** run the commands below.

```bash
./run.sh                         # first run creates .venv and installs dependencies
./run.sh /path/to/folder         # tip: type "./run.sh " then drag the folder onto Terminal
```
If you get "permission denied", run `chmod +x run.sh run.command` once.

The panel opens at http://127.0.0.1:8765. You can load a folder in four ways:
- **Open folder…**, which opens the native macOS dialog
- pasting a path into the box
- **dragging a folder onto the page** (the server finds it with Spotlight by name and file sizes)
- passing the folder as the argument to `run.sh`

The last folder is reopened automatically. Files are analysed in place, in parallel, and the
results are cached in `code/cache/`; nothing is written to your data folder. The 55 Reitstall
files (7.8 GB) take about 25 s the first time and load instantly after that.

## What the numbers mean
| Metric | Meaning | Use it for |
|---|---|---|
| **Leq** | Energy-averaged level over a bin, the standard "how loud" number | overall loudness |
| **L90** | Level exceeded 90 % of the time, i.e. the steady **background** | **persistent noise pollution** (traffic, machinery) |
| **L10** | Level exceeded 10 % of the time | frequent loud events |
| **L50 / Lmax** | Median level and loudest 125 ms frame | context |
| **Anthrophony** | Energy in the human-noise band (default 1–2 kHz) | noise sources |
| **Biophony** | Energy in the nature band (default 2–11 kHz), mostly birds and insects | natural sound |
| **NDSI** | (bio − anthro)/(bio + anthro), from −1 to +1 | **below 0 means human noise dominates** |

- **Units:** the recorder is not calibrated, so levels are **dBFS** (0 = full-scale RMS) and are
  relative. They are comparable between your recordings from the same recorder and gain. If you
  know a calibration offset, enter it in **Calib. offset** and the labels change to "dB SPL≈".
- **Weighting:** **A** follows human hearing and is the basis of noise regulations. **Z** is
  unweighted. When Z is much higher than A, a lot of the energy is low-frequency rumble.
- **Percentiles** are taken over the 125 ms frames inside each bin. At 125 ms resolution there is
  no range, and at 1 s the range rests on only 8 frames. The L10–L90 range is most meaningful at
  10 s or coarser.

## Frequency bands (adjustable)
Click **Bands:** in the top bar to set the anthrophony and biophony limits in Hz. These limits drive
the band levels, NDSI, heatmap and summary. There are two presets:
- **Standard NDSI** (1–2 / 2–11 kHz), the published convention, which lets you compare with other studies
- **Traffic / low-frequency** (50–1000 Hz / 2–11 kHz), because road traffic and machinery are mostly below 1 kHz

Applying new limits re-analyses all files once (about 25 s). Each band setting is cached
separately, so switching back to an earlier one is instant. The setting is remembered between runs.

## Places
Pass the **parent data folder**. Each sub-folder of it is a **place**, and its name is the place name:
```
data/
  SMM07134_Reitstall/Data/*.wav     -> place "SMM07134_Reitstall"
  SMM07122_ORFFInstitut/Data/*.wav  -> place "SMM07122_ORFFInstitut"
```
If you load a single place folder directly, or a folder with the audio directly inside it, that
folder is the one place.

- **Place** (top bar, shown when there are 2 or more places) chooses `All places` or one place, for
  both tabs. Each place keeps the same colour everywhere.
- **Compare places** (Timeline, `All places`, Day or All scope) draws one line per place on a
  **shared clock-time axis**. The recording periods of all places are merged and laid end to end,
  so parallel recorders line up. You can pick the metric (Leq, L90, L10, bands, NDSI). Click a line
  to play that place at that moment. If you turn it off, the places are shown one after another,
  each with a coloured boundary.
- **Overlay days** is available when one place is selected, so you can follow the same place
  over time.
- **Loudest moments** are tagged with their place, and with `All places` they are ranked across
  places.
- **Summary**
  - **Group by Place** gives one row per place. **Group by Day** gives one row per place and day,
    and its chart shows each day with one bar per place, with a line joining each place's days.
  - **Heatmap rows**: *Days* shows place · day rows. *Places (typical day)* shows one row per place,
    with all of that place's days pooled per time-of-day slot.
- **CSV exports** include a `place` column.

## Panel
- **Timeline**
  - Scope: **File / Day / All**. Files are joined end to end with dashed separators, and solid
    lines mark day boundaries. The x labels are real clock times.
  - Views: **Level**, **Leq + L10–L90**, and **Bands + NDSI** (NDSI is in its own chart below).
  - **Resolution:** *Auto* picks the finest level that fits on screen and gets finer as you zoom
    (drag to zoom, double-click to reset). You can also force 125 ms, 1 s, 10 s, 1 min or 5 min.
  - **Click anywhere to listen from that moment.** A playhead follows the audio, playback
    continues into the next file, and the space bar toggles play/pause.
  - **Overlay days** (Day scope) puts every day on one time-of-day axis, so recurring noise
    stands out.
  - **Spectrogram** sits under the loudness plot, with the same time axis, zoom and click-to-play.
    It shows a per-second 1/6-octave **overview** for long spans. When you zoom to 10 min or less,
    it switches to a **detailed** spectrogram computed directly from the audio (2048-sample FFT,
    about 22 Hz resolution). The frequency axis can be **Log** or **Linear**, and the band limits
    are drawn as dashed lines. Colour shows power spectral density (dB re FS²/Hz) with automatic
    contrast: darker means louder in light mode, brighter means louder in dark mode.
  - **Threshold** draws a line and shades the time above it.
  - **Loudest moments** lists the top 1-second peaks; click one to zoom in and play it.
- **Summary**
  - A **heatmap** of day × time of day for any metric. Click a cell to play that moment.
  - Leq plus the L90–L10 range per file or day.
  - A sortable table, including % of time above the threshold.
- **Export CSV** saves the summary or the binned time series.

## Layout
```
run.sh            install + start (run.command = macOS double-click, run.bat = Windows)
app/analysis.py   DSP: 125 ms frame energies (Z, A-weighted IIR, 1–2 kHz / 2–11 kHz via FFT)
app/aggregate.py  energy-correct binning, percentiles, NDSI, summary, heatmap, events, place comparison
app/catalog.py    folder scan; place = first sub-folder; start time from filename (YYYYMMDD_HHMMSS), GUANO, or mtime
app/spectro.py    spectrogram: overview from cached spectra, detailed STFT from audio
app/server.py     FastAPI API + audio streaming (HTTP Range for seeking)
static/           frontend (uPlot, vendored, works offline)
tests/            pytest: calibration tones, A-weighting, NDSI, custom bands, rebinning,
                  percentiles, spectrogram (detailed + overview), places (layout, comparison, rows)
```
Run the tests with `.venv/bin/python -m pytest -q tests`.
