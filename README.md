# Lobi

Desktop focus feedback built on **MediaPipe Face Landmarker** landmarks in the browser (`src/tracker.js`), a **0–100 concentration score** (`src/insights.js`), and tunable constants in **`src/neurogaze-config.js`** (single source of truth for thresholds and weights).

This document describes **exactly** what is computed in code and **why** those quantities are used.

---

## Pipeline overview

1. **Video** → Face Landmarker runs about every **67 ms** (~15 Hz) on a 640×480 stream.
2. **Per frame**, raw geometric signals are derived from normalized landmark coordinates \((x,y)\in[0,1]^2\) (image space; \(y\) increases downward).
3. **Rolling means** (length `FEATURE_MA_WINDOW`) smooth pose and auxiliary scalars **unless** a **motion gate** says the head/eyes are moving too fast (then smoothing buffers are frozen except on the first sample after a reset).
4. **`InsightEngine.update`** consumes the tracker output, maintains internal timers and a **PERCLOS-like** buffer, then applies the **focus model** at **`SCORE_TICK_HZ`** (asynchronous from raw frame rate).

All symbol names below match `neurogaze-config.js` unless noted.

---

## Vision stack

- **Detector**: Google [MediaPipe Tasks Vision](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker) **Face Landmarker** (float16 model), `VIDEO` mode, one face, GPU delegate when available.
- **Why**: Stable, real-time 2D/3D-ish facial landmarks without shipping a custom vision model; suitable for continuous monitoring.

---

## Face quality gate (`geometryReliable`)

Before any score logic trusts a frame, `faceGeometryReliable` requires:

- Inter-ocular width \(d_x = |x_{263}-x_{33}|\) in \([`FACE_MIN_INTER_EYE`, `FACE_MAX_INTER_EYE`]\).
- Face height \(d_y = |y_{152}-y_{10}|\) ≥ `FACE_MIN_HEIGHT`.

**Why**: Rejects tiny faces, partial crops, and extreme perspective where later ratios (pitch, roll, EAR) are unstable.

---

## Eye Aspect Ratio (EAR)

We use the **six-point** EAR layout from the blink / drowsiness literature: **P1–P6** label the 2D eye landmarks, with **P1–P4** spanning eye **width** and **P2↔P6**, **P3↔P5** forming two **vertical** pairs for eye **height** (open vs closed), as in Dewi *et al.*, Figure 2 — open and closed eyes with facial landmarks (P1…P6) ([Electronics *2022*, *11*(19), 3183](https://doi.org/10.3390/electronics11193183)).

Per eye (Euclidean distances in normalized image coordinates):

\[
\mathrm{EAR}_{\mathrm{eye}} = \frac{\|P_2-P_6\| + \|P_3-P_5\|}{2\,\|P_1-P_4\|}
\]

In code (`earFromSixLandmarks`), the landmark array is ordered \([P_1, P_2, P_3, P_4, P_5, P_6]\) → **MediaPipe** indices:

| Point | Left eye (`LEFT_EYE_6`) | Right eye (`RIGHT_EYE_6`) |
|--------|-------------------------|----------------------------|
| \(P_1\) | 33 | 362 |
| \(P_2\) | 160 | 385 |
| \(P_3\) | 158 | 387 |
| \(P_4\) | 133 | 263 |
| \(P_5\) | 153 | 373 |
| \(P_6\) | 144 | 380 |

Tracker uses **bilateral mean** \(\mathrm{EAR} = (\mathrm{EAR}_L + \mathrm{EAR}_R)/2\).

- **Blink / closed**: \(\mathrm{EAR} < \texttt{EAR\_THRESHOLD}\) with **`EAR_THRESHOLD` = 0.2** only (one global cutoff in `neurogaze-config.js`).
- **Note**: The value passed into insights for PERCLOS is the **per-frame EAR** (not the moving-average buffer); the MA buffers in the tracker are used for **smoothed pose/aux** outputs, not for re-exporting EAR.

**Threshold choice**: Many papers use a predetermined **0.2** for blink labeling. Offline sweeps over other cutoffs (e.g. 0.18, 0.225, 0.25) can show different best values for accuracy or AUC on a **specific** dataset (for example smaller apparent eye size, glasses, or driving pose can shift EAR scale). Lobi does **not** vary the cutoff by user or apply **steeper score penalties** when EAR is far below threshold; behavior is intentionally a **single static 0.2** for simplicity and consistency across sessions.

**Why**: EAR is a standard, lightweight proxy for eye openness from landmarks, used for blinks and drowsiness-style signals without iris segmentation.

**Further reading**: Dewi *et al.* discuss fixed EAR thresholds and dataset-dependent behavior (e.g. accuracy vs threshold); the classic EAR definition builds on Soukupová & Čech (CVWW 2016).

---

## Head pose proxies (2D geometry)

Let **face height** \(f_h = |y_{152}-y_{10}|\) (chin–forehead), **inter-eye width** \(f_w = |x_{263}-x_{33}|\), eye midpoints in \(x\) and \(y\), nose tip index 4.

### Pitch (chin-down / “downward attention” proxy)

\[
\text{pitch} = \frac{y_{\mathrm{nose}} - \frac{y_{10}+y_{152}}{2}}{f_h}
\]

Larger **positive** pitch ⇒ nose shifted **down** relative to face box ⇒ **looking down** (keyboard/phone-like) in this coordinate convention.

### Yaw (side turn, normalized)

\[
\text{yaw} = \frac{x_{\mathrm{nose}} - x_{\mathrm{eyeMid}}}{f_w}
\]

Used for **pose grace** (below): large \(|yaw|\) fades pitch/roll penalties because ultrawide monitors and head turns skew 2D landmarks.

### Roll (head tilt)

Roll is the angle of the outer-eye segment vs horizontal:

\[
\text{roll} = \mathrm{atan2}(y_{263}-y_{33},\, x_{263}-x_{33})
\]

**Why**: Roll captures “head on desk / sideways phone” style tilt; pitch captures “looking down”; yaw helps **suppress false positives** when the user is still engaged but turned toward another monitor.

Smoothed values `pitchSmoothed`, `yawSmoothed`, `rollRadSmoothed` are **arithmetic means** over the last `FEATURE_MA_WINDOW` accepted samples (see motion gate).

---

## Chin-down latch (`chinDown`)

Hysteresis on **smoothed pitch**:

- Latch **on** if `pitchSmoothed` > `HEAD_PITCH_CHIN_DOWN_ONSET` (0.185).
- Latch **off** if `pitchSmoothed` < `HEAD_PITCH_CHIN_DOWN_RELEASE` (0.125).

`chinDown` is true only if latched **and** `|yawSmoothed| < HEAD_YAW_MAX_FOR_CHIN_DOWN` (0.44).

**Why**: Hysteresis avoids flicker from landmark noise. Yaw cap avoids treating a **side glance** at another screen as “phone down” when pitch is projection-skewed.

---

## Look-up proxy (`lookUpNorm`)

Let **gap** \(= (y_{\mathrm{nose}} - y_{\mathrm{eyeMid}}) / f_h\) (nose below eyes in normal forward pose makes this **positive**).

\[
\text{fromGap} = \max(0,\; \texttt{LOOK\_UP\_GAP\_BASELINE} - \text{gap})
\]
\[
\text{fromPitch} = \max(0,\; \texttt{LOOK\_UP\_PITCH\_DEADBAND} - \text{pitch}) \times \texttt{LOOK\_UP\_PITCH\_GAIN}
\]
\[
\text{lookUpNorm} = \min(0.4,\; \text{fromGap} + \text{fromPitch})
\]

**Why**: When the user tilts **back** (ceiling / “away” gaze), the nose–eye vertical gap **shrinks** and pitch goes **more negative** in this formulation; the metric flags that distinct from chin-down.

---

## Lip opening (`lipNorm`)

\[
\text{lipNorm} = \frac{|y_{14}-y_{13}|}{f_h}
\]

**Why**: Large sustained mouth opening is used as a **yawn / jaw fatigue** cue (secondary to head pose in the score).

---

## Iris / gaze motion gate (`concentrationFrameTrusted`)

When eyes are open, the tracker stores the midpoint of **both irises** (indices 468/473) if available, else eye-region fallback, in a **1.5 s** buffer. Over the last **`ANALYSIS_WINDOW_MS` (500 ms)** it computes mean **normalized** speed between consecutive samples (skips \(\Delta t > 200\) ms).

If there are at least **4** samples and mean speed **>** `MOTION_GATE_MEAN_SPEED` (0.28), the frame is **motion-heavy**: feature MA buffers **do not** update (so pose/lip/look-up stay stable during saccades), and `concentrationFrameTrusted` becomes false when combined with open eyes.

**Geometry** must also pass `geometryReliable`.

**Why**: Rapid eye/head motion makes single-frame landmarks a poor proxy for “steady work”; gating avoids punishing or smoothing across meaningless jitter.

---

## Blinks

- Transition **closed** (`EAR` < threshold) records `blinkCloseStart`.
- On reopening, if duration ∈ (50 ms, 800 ms], `blinkJustCompleted` is set and `lastCompletedBlinkDurationMs` stored.

**Why**: Longer closure patterns can indicate fatigue or intentional breaks; the score applies a **spike penalty** after a completed blink (see below).

---

## PERCLOS-like proxy (`perclos`)

Not full PERCLOS (percentage of eyelid closure); a **binary window**:

- Each frame with a face: append **1** if \(\mathrm{EAR} < \texttt{EAR\_THRESHOLD}\), else **0**, to a FIFO of length **`PERCLOS_WINDOW`** (28 samples ≈ ~2 s at ~15 Hz).
- \(\texttt{perclos} = \frac{\sum \text{samples}}{N}\), the fraction of “closed” frames in the window.

**Why**: Mirrors the **spirit** of PERCLOS—**proportion of time eyes appear closed** over a horizon—as a fatigue / droopiness signal without specialized eye cameras.

---

## Sustained “off-task” timers

### \(T_{\mathrm{off}}\) — chin-down dwell (phone / reading-down proxy)

While **`chinDown`**, **`concentrationFrameTrusted`**, and “eyes openish” (\(\mathrm{EAR} \ge \texttt{EAR\_THRESHOLD} - 0.02\)):

\[
T_{\mathrm{off}} \mathrel{+}= \Delta t
\]

When **not** chin-down, \(T_{\mathrm{off}}\) decays: \(\max(0,\; T_{\mathrm{off}} - \Delta t \cdot \texttt{T\_OFF\_DECAY\_PER\_SEC})\).

**Why**: Short downward glances are normal; **accumulated** chin-down time matches the design intent in `neurogaze.txt`: micro-distractions &lt; ~5 s ignored, stronger effect after tens of seconds (tiered `gPhone`).

### \(T_{\mathrm{roll}}\) — sustained head roll

Define **roll severity** \(s \in [0,1]\):

\[
s = \mathrm{clamp01}\!\left(\frac{|\text{roll}| - \texttt{HEAD\_ROLL\_OFF\_RAD}}{\texttt{ROLL\_SEV\_SPAN\_RAD}}\right) \times \texttt{poseGrace}(|yaw|)
\]

`poseGrace` linearly ramps from 1 at `HEAD_YAW_POSE_GRACE_START` to 0 by `HEAD_YAW_POSE_GRACE_END`.

While \(s > 0\), trusted, eyes openish: \(T_{\mathrm{roll}} \mathrel{+}= \Delta t\). Else decay with `T_ROLL_DECAY_PER_SEC`.

**Why**: Same **tiered dwell** idea as \(T_{\mathrm{off}}\), but for **sustained head tilt** rather than chin-down.

---

## Focus score dynamics (`InsightEngine`)

Internal **`rawScore`** in \([0,100]\); UI **`score`** is rounded **EMA**:

\[
\text{display} \leftarrow \texttt{DISPLAY\_SCORE\_SMOOTH}\cdot \text{display} + (1-\texttt{DISPLAY\_SCORE\_SMOOTH})\cdot \text{raw}
\]

### Calibration

Until **`CALIBRATION_FRAMES`** consecutive face frames with reliable geometry, the engine stays calibrating (`rawScore`/`displayScore` held at 100, timers cleared).

### Score ticks (only when calibrated **and** `concentrationFrameTrusted`)

Time debt accumulates in seconds; each **`TICK_SEC = 1 / SCORE_TICK_HZ`** (8 Hz), up to 4 steps per `update` call:

**Helper functions (match code):**

- \(f_p = f_{\text{pitch}}(\text{pitch}) \times \texttt{poseGrace}(|yaw|)\) with \(f_{\text{pitch}}\) piecewise linear from `F_PITCH_SOFT` to `HEAD_PITCH_OFF_POS`.
- \(g = g_{\text{phone}}(T_{\mathrm{off}}, \texttt{perclos})\): tiered ramp with parameters `G_PHONE_*`, `T_OFF_*`; soft tier blends with `eyeSoft(perclos)` below `T_OFF_SOFT_CAP_SEC`.
- \(g_r = g_{\text{roll}}(T_{\mathrm{roll}})\): analogous tiered ramp (`G_ROLL_*`, `T_ROLL_*`).
- Roll weight: \(\text{rollWeighted} = s \cdot g_r\) with \(s\) as above.
- **Eye gate**: \(\text{gate} = \texttt{EYE\_GATE\_MIN} + (1-\texttt{EYE\_GATE\_MIN})\cdot \texttt{perclos}\).

**Head term** (fatigue reduces effective “openness” of penalties):

\[
\text{headTerm} = (f_p \cdot g + \text{rollWeighted}) \cdot \text{gate}
\]

**Auxiliary severities** (all in \([0,1]\)):

- Yawn: from `lipNorm` above `YAWN_LIP_THRESHOLD`.
- Look-up: `lookUpSeverity` ≈ \(\min(1,\; u / 0.14)\) for smoothed look-up \(u\).

**Bad signal** (clamped to \([0,1]\)):

\[
\text{bad} = \mathrm{clamp01}\!\big(\text{headTerm} + \texttt{W\_YAWN}\,y + \texttt{W\_LOOK\_UP}\,u + \texttt{W\_PERCLOS\_DIRECT}\,\texttt{perclos}\big)
\]

**Good signal** (clamped):

\[
\text{forward} = (1 - 0.92\,f_p)(1 - 0.9\,\text{rollWeighted})
\]
\[
\text{auxClear} = (1 - 0.85\,y)(1 - 0.85\,u)
\]
\[
\text{good} = \mathrm{clamp01}\!\big(\text{forward}\cdot \text{auxClear}\cdot (\texttt{perclos}<0.35 \;?\; 1 : 1-\texttt{perclos})\big)
\]

**Asymmetric update** (with **`penScale`** = warmup ramp 0.5→1 over **`WARMUP_SEC`**):

- If \(\text{bad} > \texttt{BAD\_SIGNAL\_THRESHOLD}\):  
  \(\text{raw} \mathrel{-}= \texttt{SCORE\_DROP\_PER\_SEC} \cdot \text{bad} \cdot \text{penScale} \cdot \texttt{TICK\_SEC}\)
- Else if \(\text{good} > \texttt{GOOD\_SIGNAL\_THRESHOLD}\):  
  \(\text{raw} \mathrel{+}= \texttt{SCORE\_RECOVER\_PER\_SEC} \cdot \text{good} \cdot (100-\text{raw}) \cdot \texttt{TICK\_SEC}\)

Then clamp `raw` to \([0,100]\).

**Why this shape**: Asymmetric **drop vs recover**, tiered dwell for “phone down,” and slower displayed score are exactly the UX and vigilance-inspired behavior spelled out in **`neurogaze.txt`** (task-switching / interruption timing, gradual recovery).

### Blink spike (same `update`, after ticks)

If `blinkJustCompleted` and frame trusted:

\[
\text{spike} = \min(\texttt{BLINK\_SPIKE\_CAP},\; \texttt{BLINK\_SPIKE\_BASE} + \text{durationMs}\cdot \texttt{BLINK\_SPIKE\_PER\_MS})
\]
\[
\text{raw} \mathrel{-}= \text{spike} \cdot \text{penScale}
\]

---

## Design notes document (repo)

**`neurogaze.txt`** — narrative rationale for asymmetric scoring, tiered \(T_{\mathrm{off}}\) phases (~5 s ignore, soft 5–15 s, stronger 15–30 s, 30 s+), suggested tick rate and EMA smoothing. The **implemented** equations and constants are in **`src/neurogaze-config.js`** and **`src/insights.js`**; where they differ, **code wins**.

---

## Quick reference: key constants

| Constant | Role |
|----------|------|
| `EAR_THRESHOLD` | Open vs closed eye for EAR and PERCLOS bits |
| `FEATURE_MA_WINDOW` | Samples in rolling mean for pose / lip / look-up |
| `SCORE_TICK_HZ` | Internal score integration rate |
| `DISPLAY_SCORE_SMOOTH` | EMA smoothing for displayed score |
| `SCORE_DROP_PER_SEC` / `SCORE_RECOVER_PER_SEC` | Asymmetric sensitivity |
| `T_OFF_*`, `G_PHONE_*` | Tiered chin-down / “phone” penalty ramp |
| `T_ROLL_*`, `G_ROLL_*` | Tiered sustained-roll penalty ramp |
| `PERCLOS_WINDOW` | Length of binary closed-eye history |
| `W_YAWN`, `W_LOOK_UP`, `W_PERCLOS_DIRECT` | Auxiliary bad-signal weights |

---

## How to test (manual)

1. Run the app, grant camera, open the dashboard if applicable.
2. **Calibration**: Hold a normal working pose until calibration completes (~30 stable frames).
3. **Chin-down**: Look down for 5+ s with eyes open — watch \(T_{\mathrm{off}}\) / score response after ignore window.
4. **Yaw / multi-monitor**: Turn head sideways — verify pose grace reduces pitch/roll penalties at high \(|yaw|\).
5. **Fatigue proxy**: Partially close eyes — `perclos` rises; eye gate and `W_PERCLOS_DIRECT` should drag score.
6. **Motion**: Rapidly move head/eyes — `concentrationFrameTrusted` false should pause score ticks.

