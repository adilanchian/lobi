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

**Why**: EAR is a standard, lightweight proxy for eye openness from landmarks, used for blinks and drowsiness-style signals without iris segmentation.

---

## Head pose proxies (2D geometry)

Let **face height** \(f_h = |y_{152}-y_{10}|\) (chin–forehead), **inter-eye width** \(f_w = |x_{263}-x_{33}|\), eye midpoints in \(x\) and \(y\), nose tip index 4.

### Pitch (chin-down / "downward attention" proxy)

\[
\text{pitch} = \frac{y_{\mathrm{nose}} - \frac{y_{10}+y_{152}}{2}}{f_h}
\]

Larger **positive** pitch ⇒ nose shifted **down** relative to face box ⇒ **looking down** (keyboard/phone-like) in this coordinate convention.

### Yaw (side turn, normalized)

\[
\text{yaw} = \frac{x_{\mathrm{nose}} - x_{\mathrm{eyeMid}}}{f_w}
\]

Used for **pose grace** (suppresses pitch/roll penalties on extreme turns) and **T_yaw distraction** (single-monitor only — see below).

### Roll (head tilt)

Roll is the angle of the outer-eye segment vs horizontal:

\[
\text{roll} = \mathrm{atan2}(y_{263}-y_{33},\, x_{263}-x_{33})
\]

**Why**: Roll captures "head on desk / sideways phone" style tilt; pitch captures "looking down"; yaw helps **suppress false positives** when the user is still engaged but turned toward another monitor.

Smoothed values `pitchSmoothed`, `yawSmoothed`, `rollRadSmoothed` are **arithmetic means** over the last `FEATURE_MA_WINDOW` accepted samples (see motion gate).

---

## Chin-down latch (`chinDown`)

Hysteresis on **smoothed pitch**:

- Latch **on** if `pitchSmoothed` > `HEAD_PITCH_CHIN_DOWN_ONSET` (0.185).
- Latch **off** if `pitchSmoothed` < `HEAD_PITCH_CHIN_DOWN_RELEASE` (0.125).

`chinDown` is true only if latched **and** `|yawSmoothed| < HEAD_YAW_MAX_FOR_CHIN_DOWN` (0.44).

**Why**: Hysteresis avoids flicker from landmark noise. Yaw cap avoids treating a **side glance** at another screen as "phone down" when pitch is projection-skewed.

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

**Why**: When the user tilts **back** (ceiling / "away" gaze), the nose–eye vertical gap **shrinks** and pitch goes **more negative** in this formulation; the metric flags that distinct from chin-down.

---

## Lip opening (`lipNorm`)

\[
\text{lipNorm} = \frac{|y_{14}-y_{13}|}{f_h}
\]

**Why**: Large sustained mouth opening is used as a **yawn / jaw fatigue** cue.

---

## Iris / gaze motion gate (`concentrationFrameTrusted`)

When eyes are open, the tracker stores the midpoint of **both irises** (indices 468/473) if available, else eye-region fallback, in a **1.5 s** buffer. Over the last **`ANALYSIS_WINDOW_MS` (500 ms)** it computes mean **normalized** speed between consecutive samples (skips \(\Delta t > 200\) ms).

If there are at least **4** samples and mean speed **>** `MOTION_GATE_MEAN_SPEED` (0.28), the frame is **motion-heavy**: feature MA buffers **do not** update, and `concentrationFrameTrusted` becomes false when combined with open eyes.

**Why**: Rapid eye/head motion makes single-frame landmarks a poor proxy for "steady work"; gating avoids punishing or smoothing across meaningless jitter.

---

## Blinks

- Transition **closed** (`EAR` < threshold) records `blinkCloseStart`.
- On reopening, if duration ∈ (50 ms, 800 ms], `blinkJustCompleted` is set and `lastCompletedBlinkDurationMs` stored.

Blink events feed the **Eye Comfort** subscore (see below).

---

## PERCLOS-like proxy (`perclos`)

Not full PERCLOS (percentage of eyelid closure); a **binary window**:

- Each frame with a face: append **1** if \(\mathrm{EAR} < \texttt{EAR\_THRESHOLD}\), else **0**, to a FIFO of length **`PERCLOS_WINDOW`** (45 samples ≈ ~3 s at ~15 Hz).
- \(\texttt{perclos} = \frac{\sum \text{samples}}{N}\), the fraction of "closed" frames in the window.

**Why**: Mirrors the **spirit** of PERCLOS—proportion of time eyes appear closed—as a fatigue/droopiness signal without specialized eye cameras.

---

## Sustained off-task timers

All four timers share the same accumulate/decay pattern: they tick upward on trusted frames with eyes open and the relevant signal active, and decay back to zero when the signal clears.

### \(T_{\mathrm{off}}\) — chin-down dwell (phone / reading-down proxy)

Accumulates while **`chinDown`**, **`concentrationFrameTrusted`**, and eyes openish. Decays at `T_OFF_DECAY_PER_SEC` when not chin-down.

Three-tier ramp `gPhone(T, perclos)`:
- **[0, 8 s)**: soft tier — `G_PHONE_ALPHA · T · eyeBlend(perclos)` where `eyeBlend = EYE_BLEND_MIN + (1−EYE_BLEND_MIN)·perclos`; awake users register at 55% strength (raised from 28% to make short phone checks register sooner).
- **[8, 18 s)**: confirmed tier — adds `G_PHONE_BETA · (T−8)`.
- **18 s+**: exponential tail — `G_PHONE_GAMMA · (exp((T−18)/τ) − 1)`.

**Why**: Tightened from 15 s / 30 s windows so brief sustained looks-down register meaningfully rather than requiring 15–30 s of continuous distraction.

### \(T_{\mathrm{roll}}\) — sustained head roll

Accumulates while `rollSeverity(roll) × poseGrace(|yaw|) > 0`, trusted, eyes openish. Decays at `T_ROLL_DECAY_PER_SEC`.

Three-tier ramp `gRoll(T)` with `G_ROLL_*` and `T_ROLL_*` constants. **Currently tracked but not used in scoring** (available for future reintroduction).

### \(T_{\mathrm{look}}\) — sustained look-up

Accumulates while `lookUpSeverity(lookUp) ≥ LOOK_UP_SEVERITY_ONSET`, trusted, eyes openish. Decays at `T_LOOK_DECAY_PER_SEC`.

Three-tier ramp `gLook(T)`. **Currently tracked but not used in scoring** (available for future reintroduction).

### \(T_{\mathrm{yaw}}\) — sustained lateral gaze (single-monitor only)

Accumulates while `|yaw| ≥ T_YAW_ONSET_NORM` (0.36, roughly 20°+), trusted, eyes openish, **and `hasMultipleMonitors` is false**. When multiple monitors are detected via the Electron `screen` API, `T_yaw` decays immediately and contributes nothing to scoring.

Three-tier ramp `gYaw(T)` with `G_YAW_*` and `T_YAW_*` constants, 2 s grace window before accumulation starts.

**Why**: Repeated sideways glances on a single monitor signal distraction (phone to the side, looking around the room). Multi-monitor users — including laptop + external display — are explicitly excluded because a sustained high yaw angle simply means they're working on their other screen.

---

## Multi-monitor detection

On startup and whenever a monitor is plugged or unplugged, the Electron main process calls `screen.getAllDisplays()` and pushes the count to the renderer via IPC. The dashboard stores this as `displayCount` and passes `hasMultipleMonitors: displayCount > 1` into every `InsightEngine.update()` call.

A laptop with one external display counts as 2 displays, correctly suppressing yaw penalties.

---

## Focus score: component model (`InsightEngine`)

The score is a **three-component average**, each subscore 0–100, evaluated at `SCORE_TICK_HZ` (8 Hz) when calibrated and `concentrationFrameTrusted`.

### Eye Comfort (blink rate)

Tracks how often the user blinks against a **15 BPM** healthy baseline (stored as `EYE_COMFORT_BASELINE_BPM`). Screen workers typically blink 3–8× per minute, well below this target.

- Blinks are recorded in a **45 s rolling window** (`EYE_COMFORT_WINDOW_MS`).
- Current BPM is EMA-smoothed toward the raw window rate (α = 0.18 per frame).
- A **7 s grace** (`EYE_COMFORT_GRACE_MS`) after calibration completes holds the score at 100 while the window fills.
- **Deficit** = max(0, baseline − smoothedBpm). If deficit > 0, score decays at `min(EYE_COMFORT_MAX_DECAY_PER_SEC, EYE_COMFORT_DECAY_K · ratio²)` per second (quadratic — small deficits decay slowly, large deficits faster). If deficit ≤ 0, score recovers at `EYE_COMFORT_RECOVER_PER_SEC` per second.

### Engagement (phone distraction + lateral gaze)

\[
\text{engagementScore} = 100 \times (1 - \mathrm{clamp01}(\text{phoneBad} + \text{yawBad}))
\]

Where:

\[
\text{phoneBad} = \mathrm{clamp01}\!\big(f_{\text{pitch}}(\text{pitch}) \times \text{poseGrace}(|yaw|) \times g_{\text{phone}}(T_{\mathrm{off}}, \text{perclos}) \times \text{gate}\big)
\]

\[
\text{yawBad} = \begin{cases} 0 & \text{if hasMultipleMonitors} \\ \mathrm{clamp01}(g_{\text{yaw}}(T_{\mathrm{yaw}}) \times \text{gate}) & \text{otherwise} \end{cases}
\]

**Eye gate**: \(\text{gate} = \texttt{EYE\_GATE\_MIN} + (1-\texttt{EYE\_GATE\_MIN}) \times \texttt{perclos}\) — drowsiness amplifies all penalties.

### Energy (eye closure / fatigue)

\[
\text{perclosEnergy} = \mathrm{clamp01}\!\left(\frac{\text{perclos} - \texttt{ENERGY\_PERCLOS\_GRACE}}{1 - \texttt{ENERGY\_PERCLOS\_GRACE}}\right)
\]

\[
\text{energyScore} = 100 \times (1 - \text{perclosEnergy})
\]

`ENERGY_PERCLOS_GRACE` is **0.03** (lowered from 0.08) so alert users register some energy cost rather than always sitting at 100. No artificial cap — full PERCLOS range can move the score to 0.

### Combined score

\[
\text{combinedScore} = \frac{\text{eyeComfortScore} + \text{engagementScore} + \text{energyScore}}{3}
\]

---

## Ultradian session decay

After calibration completes, **active session seconds** (`#activeSessionSec`) accumulate only while the face is present and geometry is reliable — stepping away or poor lighting acts as a natural pause.

At each score tick, the combined score is multiplied by a **Gaussian decay factor**:

\[
\text{decay} = \exp\!\left(-\left(\frac{t_{\mathrm{active\,min}}}{\texttt{SESSION\_DECAY\_TAU\_MIN}}\right)^{\!\texttt{SESSION\_DECAY\_BETA}}\right)
\]

With `SESSION_DECAY_TAU_MIN = 540` (9 h, one biological work day) and `SESSION_DECAY_BETA = 2` (Gaussian shape — starts nearly flat, then steepens):

| Active session time | Decay factor | Score penalty |
|---|---|---|
| 90 min (end of ultradian cycle 1) | 0.973 | −3% |
| 180 min (end of cycle 2) | 0.895 | −10% |
| 270 min (end of cycle 3) | 0.779 | −22% |
| 360 min (end of cycle 4) | 0.641 | −36% |

**Why**: Ultradian rhythms run in ~90-minute cycles. Cognitive performance degrades across cycles without rest. The Gaussian (β = 2) shape reflects the research pattern: negligible effect in the first cycle, then compounding degradation. The decay resets when a new session starts (`InsightEngine` is reconstructed).

---

## Displayed score

Internal `rawScore` ∈ [0, 100]. UI `score` is a rounded EMA:

\[
\text{display} \leftarrow \texttt{DISPLAY\_SCORE\_SMOOTH} \cdot \text{display} + (1-\texttt{DISPLAY\_SCORE\_SMOOTH}) \cdot \text{raw}
\]

**Calibration**: Until `CALIBRATION_FRAMES` consecutive face frames with reliable geometry, the engine stays calibrating (`rawScore`/`displayScore` held at 100, all timers cleared).

**Status labels** (based on displayed score):

| Score | Label |
|---|---|
| ≥ 80 | Locked In |
| ≥ 65 | Focused |
| ≥ 50 | Drifting |
| ≥ 35 | Low Focus |
| < 35 | Need a Break |

---

## Quick reference: key constants

| Constant | Role |
|----------|------|
| `EAR_THRESHOLD` | Open vs closed eye for EAR and PERCLOS bits |
| `FEATURE_MA_WINDOW` | Samples in rolling mean for pose / lip / look-up |
| `SCORE_TICK_HZ` | Internal score integration rate |
| `DISPLAY_SCORE_SMOOTH` | EMA smoothing for displayed score |
| `CALIBRATION_FRAMES` | Face frames required before scoring begins |
| `T_OFF_SOFT_CAP_SEC` / `T_OFF_MED_CAP_SEC` | Phone-check tier boundaries (8 s / 18 s) |
| `G_PHONE_*` | Phone penalty ramp coefficients |
| `EYE_BLEND_MIN` | Soft-zone floor for phone penalty when eyes are open (0.55) |
| `T_YAW_ONSET_NORM` | Yaw threshold to start accumulating T_yaw (~20°) |
| `G_YAW_*`, `T_YAW_*` | Lateral gaze penalty ramp (single-monitor only) |
| `PERCLOS_WINDOW` | Length of binary closed-eye history |
| `ENERGY_PERCLOS_GRACE` | PERCLOS fraction below which energy score is unaffected (0.03) |
| `EYE_COMFORT_BASELINE_BPM` | Target blink rate (15 BPM); deficit drives eye comfort decay |
| `SESSION_DECAY_TAU_MIN` | Ultradian decay time constant (540 min = 9 h) |
| `SESSION_DECAY_BETA` | Decay shape exponent (2 = Gaussian) |

---

## Insight notification system (`src/insights.js`)

Notifications are driven by a **stateful chain** in `InsightEngine` rather than a random picker, so each message is aware of what fired before it.

### Tier classification

| Score range | Tier |
|---|---|
| < 35 | `break` |
| 35–54 | `slipping` |
| 55–79 | `ok` |
| ≥ 80 | `good` |

### Chain state (private fields)

| Field | Purpose |
|---|---|
| `#insightChain` | `{ tier, depth, scoreAtFire }` — tracks the last fired tier and how many times that tier has repeated |
| `#highScoreSince` | Timestamp when score first crossed ≥ 80, used for flow milestones |
| `#flowMilestone` | Which flow milestone has already fired (`20min` / `60min`) so they only fire once per streak |
| `#bodyDecks` | Per-bucket shuffled decks for no-repeat body rotation |

### Chain logic (`#buildInsight`)

- **Same tier repeating** → `depth++` → message references the prior check-in ("still" / "again" language).
- **Slipping → break escalation** → dedicated "things slipped further" message instead of a generic break notification.
- **Recovery** (previous tier was bad, current score ≥ 70) → one-time comeback message.
- **Flow milestones**: 20 min sustained ≥ 80 → "You're in flow"; 60 min sustained → "An hour in the zone". Replaces the old `#goodFocusSince` field.

### Dynamic cooldown (`#escalatingCooldown`)

Standard cooldown is **5 min**. Drops to **~3 min** when the score has fallen 12+ points since the last insight and the current tier is still negative. Prevents long silences during a real focus crash.

### No-repeat body rotation (`#pickBody`)

Each bucket (e.g. `'slipping-1'`, `'break-2'`) maintains its own shuffled deck. All options in a bucket are cycled before any repeats, and the same body is never shown back to back. Replaced the old global `pick()` call.

### Notification copy

All negative-tier bodies were rewritten with specific, science-backed, actionable tips in plain language: box breathing, 20-20-20 rule, hydration, vagus nerve exhale, movement breaks, cold water, and nap-vs-caffeine guidance.

---

## Dashboard UI (`src/dashboard.html`)

### Stat label tooltips

The three subscore labels in the stats panel (**Screen Strain**, **Engagement**, **Energy**) each have a small `ⓘ` icon. Hovering reveals a styled bubble explaining the metric in plain English:

- **Screen Strain** — blink rate / eye strain proxy.
- **Engagement** — head position (chin-down / looking away).
- **Energy** — eye drooping / alertness (PERCLOS).

Implemented as CSS-only `.info-tip` / `.info-tip-bubble` classes. No JS changes required.

### Update flow

A dismissable **update banner** appears above the footer whenever a new version has been downloaded and is ready to install. It shows the version number and a "Restart" button — no need to spot the small footer text.

The footer "Check for updates" button still works for manual checks; its label reflects the current download state (checking / downloading / ready).

---

## Auto-update (`src/main.js`)

- **Startup check** — `autoUpdater.checkForUpdates()` runs once when the app is ready (packaged builds only).
- **Periodic check** — a `setInterval` re-runs the check every **6 hours** so users with the app open all day still receive updates automatically.
- **Tray menu** — the context menu item label reflects the current update state and changes dynamically:

| State | Tray label |
|---|---|
| Idle | Check for Updates |
| Checking | Checking for Updates… |
| Downloading | Downloading vX.Y.Z… |
| Ready | Restart to Install vX.Y.Z |
| Up to date | Up to Date ✓ |
| Error | Update Check Failed — Retry |

- **State seeding on window open** — a `get-update-state` IPC handler lets the renderer query the current state immediately on load, fixing a bug where the "Restart" button required multiple clicks if the update had downloaded before the dashboard window was opened.

---

## How to test (manual)

1. Run the app, grant camera, open the dashboard.
2. **Calibration**: Hold a normal working pose until calibration completes (~30 stable frames).
3. **Phone check**: Look down for 5–8 s with eyes open — `T_off` should accumulate and engagement score drop.
4. **Yaw distraction** (single monitor only): Turn head sideways past ~20° and hold — `T_yaw` accumulates and engagement drops. On a multi-monitor setup this should have no effect.
5. **Energy**: Partially close eyes — `perclos` rises and energy score drops (now responsive from ~3% closure rather than 8%).
6. **Eye comfort**: Avoid blinking for 30–60 s — eye comfort score should visibly decay as smoothed BPM falls below 15.
7. **Session decay**: Check `activeSessionMin` in `getLiveMetrics()` — decay factor is negligible for the first hour, then gradually steepens.
8. **Motion gate**: Rapidly move head/eyes — `concentrationFrameTrusted` false should pause score ticks.
9. **Update banner**: In a packaged build, trigger an update download and reopen the dashboard — the banner should appear immediately without needing to click anything.
10. **Tray update states**: After triggering an update check, right-click the tray icon — the menu item label should reflect the current download state in real time.
