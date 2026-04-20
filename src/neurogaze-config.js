/**
 * Single source of truth: MediaPipe / landmark pipeline + literature-informed
 * focus model (see neurogaze.txt in repo root).
 */

// ─── Landmark pipeline (tracker) ───────────────────────────────────────────

/**
 * Single static EAR cutoff for blink / closed-eye detection, PERCLOS bits, and gaze gating.
 * Fixed at 0.2 (widely cited in prior blink work). No multi-threshold EAR “blink type” tiers and
 * no extra score penalties tied to how far EAR drops below this value.
 */
export const EAR_THRESHOLD = 0.2

/** Moving-average window length on landmark-derived scalars. */
export const FEATURE_MA_WINDOW = 13

/** Normalized lip opening above = yawn-like. */
export const YAWN_LIP_THRESHOLD = 0.38

/**
 * Pitch = (noseTip.y - midY) / faceHeight. Chin-down / keyboard / phone proxy
 * increases pitch (more positive).
 */
export const HEAD_PITCH_OFF_POS = 0.24
export const HEAD_PITCH_OFF_NEG = 0.13

/**
 * Smoothed pitch above ONSET counts as chin-down; below RELEASE it clears (hysteresis).
 */
export const HEAD_PITCH_CHIN_DOWN_ONSET = 0.185
export const HEAD_PITCH_CHIN_DOWN_RELEASE = 0.125

/**
 * Normalized yaw = (noseTip.x − eyeMidX) / interEyeWidth (see tracker). Large |yaw|
 * is normal on ultrawide / multi-monitor; it also skews 2D landmarks so roll/pitch
 * look worse than they are.
 */
export const HEAD_YAW_POSE_GRACE_START = 0.26
/** Beyond this |yaw|, pitch/roll phone-style penalties are fully suppressed for pose. */
export const HEAD_YAW_POSE_GRACE_END = 0.55

/**
 * Only treat chin-down as phone / T_off when |yaw| is below this (side-monitor
 * head turns should not accumulate phone time from projection artifacts).
 */
export const HEAD_YAW_MAX_FOR_CHIN_DOWN = 0.44

/**
 * Look-up proxy: (noseTip.y − eyeMidY) / faceHeight is positive when the nose is
 * below the eyes (normal forward pose). Tilting the head back to look up shrinks
 * this gap — unlike the old (eyeMidY − nose) term, which was ≤0 in normal coords.
 */
export const LOOK_UP_GAP_BASELINE = 0.14

/** Extra look-up from head pitch: upward tilt → pitch negative in calcHeadPose. */
export const LOOK_UP_PITCH_DEADBAND = -0.02
export const LOOK_UP_PITCH_GAIN = 1.15

/** Roll (rad) of outer-eye line vs horizontal beyond this → not upright. */
export const HEAD_ROLL_OFF_RAD = 0.11

/** Iris motion gate — mean normalized speed above this freezes MA writes. */
export const MOTION_GATE_MEAN_SPEED = 0.28

export const FACE_MIN_INTER_EYE = 0.06
export const FACE_MIN_HEIGHT = 0.1
export const FACE_MAX_INTER_EYE = 0.72

/**
 * Six eye landmarks per eye in order [P1, P2, P3, P4, P5, P6] (literature naming).
 * EAR = (‖P2−P6‖ + ‖P3−P5‖) / (2‖P1−P4‖); P1–P4 = width, vertical pairs = height.
 * See Dewi et al., Electronics 2022, 11(19), 3183, Fig. 2 (open/closed eye with P1–P6).
 */
export const LEFT_EYE_6 = [33, 160, 158, 133, 153, 144]
/** Same P1…P6 roles as left; order matches `earFromSixLandmarks` [P1,P2,P3,P4,P5,P6]. */
export const RIGHT_EYE_6 = [362, 385, 387, 263, 373, 380]

const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)

/** EAR from six points ordered P1…P6 (see `LEFT_EYE_6` / `RIGHT_EYE_6`). */
export function earFromSixLandmarks(lm, indices) {
  const p = indices.map((i) => lm[i])
  const v1 = dist2(p[1], p[5]) // ‖P2−P6‖
  const v2 = dist2(p[2], p[4]) // ‖P3−P5‖
  const h = dist2(p[0], p[3]) // ‖P1−P4‖
  if (h < 1e-9) return 0.3
  return (v1 + v2) / (2 * h)
}

const L_OUT = 33
const R_OUT = 263
const CHIN_I = 152
const FOREHEAD_I = 10

export function faceGeometryReliable(lm) {
  if (!lm || lm.length < R_OUT + 1) return false
  const iw = Math.abs(lm[R_OUT].x - lm[L_OUT].x)
  const ih = Math.abs(lm[CHIN_I].y - lm[FOREHEAD_I].y)
  return (
    iw >= FACE_MIN_INTER_EYE &&
    ih >= FACE_MIN_HEIGHT &&
    iw <= FACE_MAX_INTER_EYE
  )
}

// ─── Focus model (neurogaze.txt) ───────────────────────────────────────────

/** Score dynamics evaluated at this rate (Hz); vision can stay faster. */
export const SCORE_TICK_HZ = 8

/** EMA on displayed score toward internal raw score (0.8–0.9 range per txt). */
export const DISPLAY_SCORE_SMOOTH = 0.92

/** δ_down / δ_up style: max change per second at bad_signal / good_signal = 1. */
export const SCORE_DROP_PER_SEC = 18
export const SCORE_RECOVER_PER_SEC = 9

/** Early-session penalty scale: ramps from WARMUP_PENALTY_MULT to 1 over WARMUP_SEC. */
export const WARMUP_SEC = 45
export const WARMUP_PENALTY_MULT = 0.5

/** Frames with a face before scoring runs (stabilization). */
export const CALIBRATION_FRAMES = 30

/** Tiered g(T_off): T_off in seconds while chin-down (phone proxy). */
export const T_OFF_IGNORE_SEC = 5
export const T_OFF_SOFT_CAP_SEC = 15
export const T_OFF_MED_CAP_SEC = 30

/** Soft tier [5,15): α·(T−5); keep small. */
export const G_PHONE_ALPHA = 0.012

/** Confirmed tier [15,30): adds β·(T−15) on top of value at 15s. */
export const G_PHONE_BETA = 0.045

/** 30s+: extra ramp (sublinear then stronger). */
export const G_PHONE_GAMMA = 0.06
export const G_PHONE_LONG_TAU = 14

/**
 * Phase 2 multiplier: soft ramp mostly suppressed unless eyes “degrade”
 * (PERCLOS proxy high). eyeBlend = EYE_BLEND_MIN + (1-EYE_BLEND_MIN)*perclos.
 */
export const EYE_BLEND_MIN = 0.28

/** PERCLOS-like proxy: rolling window length (samples at ~tracker rate). */
export const PERCLOS_WINDOW = 28

/** Map closed-eye fraction to fatigue gate: lerp(EYE_GATE_MIN, 1, perclos). */
export const EYE_GATE_MIN = 0.38

/** f(pitch): ramp from pitch soft start to HEAD_PITCH_OFF_POS. */
export const F_PITCH_SOFT = 0.11

/** Roll severity: |roll| beyond HEAD_ROLL_OFF_RAD scaled to ~1 by this span. */
export const ROLL_SEV_SPAN_RAD = 0.35

/** When not chin-down, T_off decays this many seconds per real second. */
export const T_OFF_DECAY_PER_SEC = 2.2

/**
 * Tiered h(T_roll): seconds accumulated while |roll| exceeds HEAD_ROLL_OFF_RAD
 * (after pose-grace), analogous to T_off for chin-down. Decays when upright.
 */
export const T_ROLL_IGNORE_SEC = 5
export const T_ROLL_SOFT_CAP_SEC = 15
export const T_ROLL_MED_CAP_SEC = 30
export const G_ROLL_ALPHA = 0.01
export const G_ROLL_BETA = 0.038
export const G_ROLL_GAMMA = 0.052
export const G_ROLL_LONG_TAU = 14
/** When head is level (or yaw grace suppresses roll), T_roll decays per real second. */
export const T_ROLL_DECAY_PER_SEC = 2.2

/** Blink spike: base + duration * scale, capped. */
export const BLINK_SPIKE_BASE = 1.0
export const BLINK_SPIKE_PER_MS = 0.007
export const BLINK_SPIKE_CAP = 7

/** Auxiliary bad weights (yawn, look-up, raw fatigue) — kept subordinate to head+phone. */
export const W_YAWN = 0.36
export const W_LOOK_UP = 0.32
export const W_PERCLOS_DIRECT = 0.55

/** Minimum bad to trigger asymmetric drop path. */
export const BAD_SIGNAL_THRESHOLD = 0.06

/** Good-signal path when above this (stable forward work). */
export const GOOD_SIGNAL_THRESHOLD = 0.52
