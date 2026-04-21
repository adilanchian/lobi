// insights.js — Focus score (0–100) from neurogaze.txt: T_off / T_roll tiers, f(P)·g(T_off),
// rollSeverity·gRoll(T_roll), EyeGate (PERCLOS proxy); composite bad → score, warmup scale, display EMA.

import {
  CALIBRATION_FRAMES,
  DISPLAY_SCORE_SMOOTH,
  EAR_THRESHOLD,
  EYE_BLEND_MIN,
  EYE_GATE_MIN,
  F_PITCH_SOFT,
  G_LOOK_ALPHA,
  G_LOOK_BETA,
  G_LOOK_GAMMA,
  G_LOOK_LONG_TAU,
  G_PHONE_ALPHA,
  G_PHONE_BETA,
  G_PHONE_GAMMA,
  G_PHONE_LONG_TAU,
  G_ROLL_ALPHA,
  G_ROLL_BETA,
  G_ROLL_GAMMA,
  G_ROLL_LONG_TAU,
  HEAD_PITCH_OFF_POS,
  HEAD_ROLL_OFF_RAD,
  HEAD_YAW_POSE_GRACE_END,
  HEAD_YAW_POSE_GRACE_START,
  LOOK_UP_SEVERITY_ONSET,
  PERCLOS_WINDOW,
  ROLL_SEV_SPAN_RAD,
  SCORE_TICK_HZ,
  T_OFF_DECAY_PER_SEC,
  T_OFF_IGNORE_SEC,
  T_OFF_MED_CAP_SEC,
  T_OFF_SOFT_CAP_SEC,
  T_ROLL_DECAY_PER_SEC,
  T_ROLL_IGNORE_SEC,
  T_ROLL_MED_CAP_SEC,
  T_ROLL_SOFT_CAP_SEC,
  T_LOOK_DECAY_PER_SEC,
  T_LOOK_IGNORE_SEC,
  T_LOOK_MED_CAP_SEC,
  T_LOOK_SOFT_CAP_SEC,
  W_LOOK_UP,
  W_YAWN,
  YAWN_LIP_THRESHOLD,
} from './neurogaze-config.js'

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]

const NOTIFY_COOLDOWN_MS = 5 * 60 * 1000
const FOCUS_MILESTONE_MS = 60 * 60 * 1000
const EYE_COMFORT_BASELINE_BPM = 15
const EYE_COMFORT_WINDOW_MS = 45_000
const EYE_COMFORT_GRACE_MS = 7_000
const EYE_COMFORT_EMA_ALPHA = 0.18
const EYE_COMFORT_DECAY_K = 1.2
const EYE_COMFORT_MAX_DECAY_PER_SEC = 1.6
const EYE_COMFORT_RECOVER_PER_SEC = 0.7
const ENERGY_PERCLOS_GRACE = 0.08

const TICK_SEC = 1 / SCORE_TICK_HZ

function clamp01(x) {
  return Math.min(1, Math.max(0, x))
}

function fPitch(p) {
  const lo = F_PITCH_SOFT
  const hi = HEAD_PITCH_OFF_POS
  if (p <= lo) return 0
  if (p >= hi) return 1
  return (p - lo) / (hi - lo)
}

function eyeSoft(perclos) {
  return EYE_BLEND_MIN + (1 - EYE_BLEND_MIN) * perclos
}

function gPhone(T, perclos) {
  if (T <= T_OFF_IGNORE_SEC) return 0
  let g = 0
  if (T > T_OFF_IGNORE_SEC) {
    const softEnd = Math.min(T, T_OFF_SOFT_CAP_SEC)
    const softSpan = softEnd - T_OFF_IGNORE_SEC
    const softBlend = T < T_OFF_SOFT_CAP_SEC ? eyeSoft(perclos) : 1
    g += G_PHONE_ALPHA * softSpan * softBlend
  }
  if (T > T_OFF_SOFT_CAP_SEC) {
    g += G_PHONE_BETA * Math.min(T - T_OFF_SOFT_CAP_SEC, T_OFF_MED_CAP_SEC - T_OFF_SOFT_CAP_SEC)
  }
  if (T > T_OFF_MED_CAP_SEC) {
    g += G_PHONE_GAMMA * (Math.exp((T - T_OFF_MED_CAP_SEC) / G_PHONE_LONG_TAU) - 1)
  }
  return g
}

function gRoll(T) {
  if (T <= T_ROLL_IGNORE_SEC) return 0
  let g = 0
  if (T > T_ROLL_IGNORE_SEC) {
    const softEnd = Math.min(T, T_ROLL_SOFT_CAP_SEC)
    const softSpan = softEnd - T_ROLL_IGNORE_SEC
    g += G_ROLL_ALPHA * softSpan
  }
  if (T > T_ROLL_SOFT_CAP_SEC) {
    g += G_ROLL_BETA * Math.min(
      T - T_ROLL_SOFT_CAP_SEC,
      T_ROLL_MED_CAP_SEC - T_ROLL_SOFT_CAP_SEC,
    )
  }
  if (T > T_ROLL_MED_CAP_SEC) {
    g += G_ROLL_GAMMA * (Math.exp((T - T_ROLL_MED_CAP_SEC) / G_ROLL_LONG_TAU) - 1)
  }
  return g
}

function gLook(T) {
  if (T <= T_LOOK_IGNORE_SEC) return 0
  let g = 0
  if (T > T_LOOK_IGNORE_SEC) {
    const softEnd = Math.min(T, T_LOOK_SOFT_CAP_SEC)
    const softSpan = softEnd - T_LOOK_IGNORE_SEC
    g += G_LOOK_ALPHA * softSpan
  }
  if (T > T_LOOK_SOFT_CAP_SEC) {
    g += G_LOOK_BETA * Math.min(
      T - T_LOOK_SOFT_CAP_SEC,
      T_LOOK_MED_CAP_SEC - T_LOOK_SOFT_CAP_SEC,
    )
  }
  if (T > T_LOOK_MED_CAP_SEC) {
    g += G_LOOK_GAMMA * (Math.exp((T - T_LOOK_MED_CAP_SEC) / G_LOOK_LONG_TAU) - 1)
  }
  return g
}

function rollSeverity(rollRad) {
  const a = Math.abs(rollRad)
  if (a <= HEAD_ROLL_OFF_RAD) return 0
  return clamp01((a - HEAD_ROLL_OFF_RAD) / ROLL_SEV_SPAN_RAD)
}

function yawnSeverity(lip) {
  if (lip <= YAWN_LIP_THRESHOLD) return 0
  return clamp01((lip - YAWN_LIP_THRESHOLD) / 0.14)
}

function lookUpSeverity(u) {
  return clamp01(u / 0.14)
}

function eyeGateMul(perclos) {
  return EYE_GATE_MIN + (1 - EYE_GATE_MIN) * perclos
}

/** On ultrawide / yaw, 2D roll & pitch skew — fade pose penalties toward zero. */
function poseGraceFromYaw(absYaw) {
  const lo = HEAD_YAW_POSE_GRACE_START
  const hi = HEAD_YAW_POSE_GRACE_END
  if (absYaw <= lo) return 1
  if (absYaw >= hi) return 0
  return 1 - (absYaw - lo) / (hi - lo)
}

export class InsightEngine {
  score = 100
  status = 'Starting up...'
  recentInsights = []

  #lastNotifyTs = 0
  #goodFocusSince = Date.now()
  #sessionStart = Date.now()
  #lastUpdateTs = 0
  #scoreSum = 0
  #scoreCount = 0
  #peakScore = 0
  #stableFrames = 0
  #calibrated = false
  #rawScore = 100
  #displayScore = 100
  #tickDebt = 0
  #tOff = 0
  /** Seconds accumulated while head tilt (roll) exceeds upright band — see gRoll(T_roll). */
  #tRoll = 0
  /** Seconds accumulated while look-up is sustained — see gLook(T_look). */
  #tLook = 0
  #perclosBuf = []
  // Last smoothed frame values for score components + high-level bars.
  #lastPitch = 0
  #lastRoll = 0
  #lastYaw = 0
  #lastLip = 0
  #lastLookUp = 0
  #eyeComfortScore = 100
  #blinkTsWindow = []
  #eyeComfortSmoothedBpm = EYE_COMFORT_BASELINE_BPM
  #eyeComfortCalibratedStartTs = 0

  get sessionMinutes() {
    return Math.floor((Date.now() - this.#sessionStart) / 60_000)
  }

  get isCalibrating() {
    return !this.#calibrated
  }

  /** Snapshot for live dashboard bars (call after `update`). */
  getLiveMetrics() {
    return {
      tOff: this.#tOff,
      tRoll: this.#tRoll,
      tLook: this.#tLook,
      rawScore: this.#rawScore,
      perclos: this.#perclosFraction(),
    }
  }

  #scoreComponents(perclos, pitch, roll, yaw, lip, lookUp) {
    const pg = poseGraceFromYaw(Math.abs(yaw))
    const gate = eyeGateMul(perclos)

    const phoneBad = clamp01(fPitch(pitch) * pg * gPhone(this.#tOff, perclos) * gate)

    const rollBad = rollSeverity(roll) * pg * gRoll(this.#tRoll) * gate
    const yawnBad = W_YAWN * yawnSeverity(lip)
    const lookBad = W_LOOK_UP * lookUpSeverity(lookUp) * gLook(this.#tLook)
    // Posture reacts to sustained tilt (T_roll) and inherits part of T_off posture drift.
    const postureBad = clamp01(rollBad + yawnBad + lookBad + phoneBad * 0.6)

    // Energy remains PERCLOS-only with a small blink grace band.
    const perclosEnergy = clamp01(
      (perclos - ENERGY_PERCLOS_GRACE) / (1 - ENERGY_PERCLOS_GRACE),
    )
    const energyBad = clamp01(perclosEnergy * 0.4)
    const eyeComfortScore = Math.max(0, Math.min(100, this.#eyeComfortScore))
    const engagementScore = 100 * (1 - phoneBad)
    const postureScore = 100 * (1 - postureBad)
    const energyScore = 100 * (1 - energyBad)
    const combinedScore =
      (eyeComfortScore + engagementScore + postureScore + energyScore) / 4

    return {
      eyeComfort: Math.round(eyeComfortScore),
      engagement: Math.round(engagementScore),
      posture: Math.round(postureScore),
      energy: Math.round(energyScore),
      combinedScore,
    }
  }

  /**
   * UI-facing 0-100 breakdown bars used by dashboard.html.
   * Shares the same component math path as the core score tick.
   */
  getHighLevelScores() {
    const perclos = this.#perclosFraction()
    const parts = this.#scoreComponents(
      perclos,
      this.#lastPitch,
      this.#lastRoll,
      this.#lastYaw,
      this.#lastLip,
      this.#lastLookUp,
    )

    return {
      eyeComfort: parts.eyeComfort,
      engagement: parts.engagement,
      posture: parts.posture,
      energy: parts.energy,
    }
  }

  update({
    facePresent,
    ear = 0.3,
    pitchSmoothed = 0,
    rollRadSmoothed = 0,
    yawSmoothed = 0,
    chinDown = false,
    lipNormSmoothed = 0,
    lookUpNormSmoothed = 0,
    geometryReliable = false,
    concentrationFrameTrusted = false,
    blinkJustCompleted = false,
    lastCompletedBlinkDurationMs = 0,
  }) {
    const now = Date.now()

    if (!facePresent) {
      this.#stableFrames = 0
      this.#perclosBuf = []
      this.#tOff = 0
      this.#tRoll = 0
      this.#tLook = 0
      this.#resetEyeComfort()
      this.status = this.#calibrated ? 'Away' : 'Waiting for face...'
      this.#pushDisplay()
      return this.score
    }

    if (!geometryReliable) {
      this.#perclosBuf = []
      this.#tOff = 0
      this.#tRoll = 0
      this.#tLook = 0
      this.#tickDebt = 0
      this.#lastUpdateTs = now
      this.#resetEyeComfort()
      this.status = this.#calibrated ? 'Away' : "Can't see face clearly"
      this.#pushDisplay()
      return this.score
    }

    if (!this.#calibrated) {
      this.#stableFrames++
      if (this.#stableFrames >= CALIBRATION_FRAMES) this.#calibrated = true
      this.#rawScore = 100
      this.#displayScore = 100
      this.#tOff = 0
      this.#tRoll = 0
      this.#tLook = 0
      this.#tickDebt = 0
    }

    const dtSec = this.#lastUpdateTs
      ? Math.min((now - this.#lastUpdateTs) / 1000, 0.5)
      : 0.067
    this.#lastUpdateTs = now

    this.#lastPitch = pitchSmoothed
    this.#lastRoll = rollRadSmoothed
    this.#lastYaw = yawSmoothed
    this.#lastLip = lipNormSmoothed
    this.#lastLookUp = lookUpNormSmoothed

    this.#updateEyeComfort(
      now,
      dtSec,
      blinkJustCompleted,
      concentrationFrameTrusted,
    )

    this.#pushPerclos(ear)

    if (this.#calibrated) {
      this.#integrateTOff(dtSec, chinDown, concentrationFrameTrusted, ear)
      this.#integrateTRoll(
        dtSec,
        rollRadSmoothed,
        yawSmoothed,
        concentrationFrameTrusted,
        ear,
      )
      this.#integrateTLook(
        dtSec,
        lookUpNormSmoothed,
        concentrationFrameTrusted,
        ear,
      )
    }

    const perclos = this.#perclosFraction()

    if (this.#calibrated && concentrationFrameTrusted) {
      this.#tickDebt += dtSec
      const maxSteps = 4
      let steps = 0
      while (this.#tickDebt >= TICK_SEC && steps < maxSteps) {
        this.#tickDebt -= TICK_SEC
        steps++
        this.#scoreTick(
          perclos,
          pitchSmoothed,
          rollRadSmoothed,
          yawSmoothed,
          lipNormSmoothed,
          lookUpNormSmoothed,
        )
      }
    }

    this.#pushDisplay()

    if (this.isCalibrating) this.status = 'Calibrating...'
    else if (this.score >= 80) this.status = 'Locked In'
    else if (this.score >= 65) this.status = 'Focused'
    else if (this.score >= 50) this.status = 'Drifting'
    else if (this.score >= 35) this.status = 'Low Focus'
    else this.status = 'Need a Break'

    if (this.score < 70) this.#goodFocusSince = now

    if (!this.isCalibrating) {
      this.#scoreSum += this.score
      this.#scoreCount++
      this.#peakScore = Math.max(this.#peakScore, this.score)
    }

    this.#maybeFireInsight(now)
    return this.score
  }

  #pushPerclos(ear) {
    this.#perclosBuf.push(ear < EAR_THRESHOLD ? 1 : 0)
    while (this.#perclosBuf.length > PERCLOS_WINDOW) this.#perclosBuf.shift()
  }

  #perclosFraction() {
    const n = this.#perclosBuf.length
    if (n === 0) return 0
    let s = 0
    for (let i = 0; i < n; i++) s += this.#perclosBuf[i]
    return s / n
  }

  #integrateTOff(dtSec, chinDown, trusted, ear) {
    const eyesOpenish = ear >= EAR_THRESHOLD - 0.02
    if (chinDown && trusted && eyesOpenish) {
      this.#tOff += dtSec
    } else if (!chinDown) {
      this.#tOff = Math.max(0, this.#tOff - dtSec * T_OFF_DECAY_PER_SEC)
    }
  }

  /**
   * Accumulates while |roll| is past upright threshold (same geometry as rollSeverity × pose grace).
   * Mirrors T_off: trusted frame + eyes openish; decays when level or yaw suppresses tilt signal.
   */
  #integrateTRoll(dtSec, rollRad, yaw, trusted, ear) {
    const eyesOpenish = ear >= EAR_THRESHOLD - 0.02
    const pg = poseGraceFromYaw(Math.abs(yaw))
    const rollS = rollSeverity(rollRad) * pg
    const rollClocking = rollS > 1e-6

    if (rollClocking && trusted && eyesOpenish) {
      this.#tRoll += dtSec
    } else if (!rollClocking) {
      this.#tRoll = Math.max(0, this.#tRoll - dtSec * T_ROLL_DECAY_PER_SEC)
    }
  }

  /** Mirrors T_off/T_roll timing so brief look-up glances do not penalize. */
  #integrateTLook(dtSec, lookUp, trusted, ear) {
    const eyesOpenish = ear >= EAR_THRESHOLD - 0.02
    const lookSev = lookUpSeverity(lookUp)
    const lookClocking = lookSev >= LOOK_UP_SEVERITY_ONSET

    if (lookClocking && trusted && eyesOpenish) {
      this.#tLook += dtSec
    } else if (!lookClocking) {
      this.#tLook = Math.max(0, this.#tLook - dtSec * T_LOOK_DECAY_PER_SEC)
    }
  }

  #scoreTick(perclos, pitch, roll, yaw, lip, lookUp) {
    const { combinedScore } = this.#scoreComponents(
      perclos,
      pitch,
      roll,
      yaw,
      lip,
      lookUp,
    )
    // Main score is a direct combination of the same four subscores.
    this.#rawScore = Math.min(100, Math.max(0, combinedScore))
  }

  #resetEyeComfort() {
    this.#eyeComfortScore = 100
    this.#blinkTsWindow = []
    this.#eyeComfortSmoothedBpm = EYE_COMFORT_BASELINE_BPM
    this.#eyeComfortCalibratedStartTs = 0
  }

  #updateEyeComfort(now, dtSec, blinkJustCompleted, trusted) {
    if (!this.#calibrated) {
      this.#eyeComfortScore = 100
      this.#eyeComfortSmoothedBpm = EYE_COMFORT_BASELINE_BPM
      this.#eyeComfortCalibratedStartTs = 0
      return
    }
    if (!this.#eyeComfortCalibratedStartTs) this.#eyeComfortCalibratedStartTs = now

    if (blinkJustCompleted && trusted) {
      this.#blinkTsWindow.push(now)
    }

    const cutoff = now - EYE_COMFORT_WINDOW_MS
    while (this.#blinkTsWindow.length && this.#blinkTsWindow[0] < cutoff) {
      this.#blinkTsWindow.shift()
    }

    const blinkCount = this.#blinkTsWindow.length
    const windowSec = EYE_COMFORT_WINDOW_MS / 1000
    const currentBpmRaw = (blinkCount / windowSec) * 60
    this.#eyeComfortSmoothedBpm +=
      (currentBpmRaw - this.#eyeComfortSmoothedBpm) * EYE_COMFORT_EMA_ALPHA

    if (now - this.#eyeComfortCalibratedStartTs < EYE_COMFORT_GRACE_MS) {
      this.#eyeComfortScore = 100
      return
    }

    const deficit = Math.max(0, EYE_COMFORT_BASELINE_BPM - this.#eyeComfortSmoothedBpm)
    const ratio = deficit / EYE_COMFORT_BASELINE_BPM

    if (deficit > 0) {
      const decayRate = Math.min(
        EYE_COMFORT_MAX_DECAY_PER_SEC,
        EYE_COMFORT_DECAY_K * ratio * ratio,
      )
      this.#eyeComfortScore -= decayRate * dtSec
    } else {
      this.#eyeComfortScore += EYE_COMFORT_RECOVER_PER_SEC * dtSec
    }

    this.#eyeComfortScore = Math.max(0, Math.min(100, this.#eyeComfortScore))
  }

  #pushDisplay() {
    this.#displayScore =
      DISPLAY_SCORE_SMOOTH * this.#displayScore +
      (1 - DISPLAY_SCORE_SMOOTH) * this.#rawScore
    this.score = Math.round(this.#displayScore)
  }

  getSessionData() {
    const now = Date.now()
    return {
      startTime: this.#sessionStart,
      endTime: now,
      durationMs: now - this.#sessionStart,
      avgScore:
        this.#scoreCount > 0 ? Math.round(this.#scoreSum / this.#scoreCount) : 0,
      peakScore: this.#peakScore,
      insightCount: this.recentInsights.length,
    }
  }

  #maybeFireInsight(now) {
    if (this.isCalibrating) return
    if (now - this.#lastNotifyTs < NOTIFY_COOLDOWN_MS) return

    const focusedFor = now - this.#goodFocusSince

    let insight = null

    if (this.score < 35) {
      insight = {
        title: 'Time for a break',
        body: pick([
          'Step away, take a few deep breaths, and look at something far away. Two minutes is all it takes to recharge.',
          'Get up, refill your water, and walk around for 2 minutes. Your brain restores faster when your body moves.',
          'Close your eyes for 30 seconds, then take a short walk. Even micro-breaks reset your ability to concentrate.',
          'Stand up, stretch your arms overhead, and look out a window. A real pause — even a quick one — beats pushing through.',
          'Your brain has been working hard. Two minutes of doing nothing is surprisingly powerful — step away from the screen.',
        ]),
      }
    } else if (this.score < 55) {
      insight = {
        title: 'Concentration slipping',
        body: pick([
          'Face the camera, level your head, and ease your jaw — the score rewards steady forward attention.',
          'Longer phone-down stretches pull the score down more than quick glances; it climbs back gradually when you re-engage.',
          'Let the score recover gradually once distractions ease.',
          "If you're fighting sleep, a short walk beats staring.",
          'Good lighting and framing keep landmark detection reliable.',
        ]),
      }
    } else if (focusedFor > FOCUS_MILESTONE_MS && this.score >= 80) {
      insight = {
        title: 'An hour in the zone',
        body: pick([
          'Seriously impressive. Take a real 10-minute break — move, hydrate, and you will come back just as sharp.',
          "That's a full hour of deep work — most people can't sustain that. Protect the streak with a proper break before the next round.",
          'An hour of real focus is rare. Reward it with 10 minutes completely away from your screen — your brain has earned it.',
          "You've been in flow for an hour. A 10-minute break now resets your cognitive resources for another strong session.",
          'One hour down. A real break now — not just scrolling — keeps your performance high for the rest of the day.',
        ]),
      }
    }

    if (!insight) return

    this.#lastNotifyTs = now
    this.recentInsights.unshift({
      ...insight,
      time: new Date().toLocaleTimeString(),
    })
    if (this.recentInsights.length > 5) this.recentInsights.pop()

    window.lobi?.sendInsight(insight.title, insight.body)
    window.dispatchEvent(new CustomEvent('lobi-insight', { detail: insight }))
  }
}
