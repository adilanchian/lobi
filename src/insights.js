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
  SESSION_DECAY_TAU_MIN,
  SESSION_DECAY_BETA,
  ENERGY_PERCLOS_GRACE,
  T_YAW_ONSET_NORM,
  T_YAW_IGNORE_SEC,
  T_YAW_SOFT_CAP_SEC,
  T_YAW_MED_CAP_SEC,
  G_YAW_ALPHA,
  G_YAW_BETA,
  G_YAW_GAMMA,
  G_YAW_LONG_TAU,
  T_YAW_DECAY_PER_SEC,
} from './neurogaze-config.js'

function shuffle(arr) {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

const NOTIFY_COOLDOWN_MS = 5 * 60 * 1000
const FOCUS_MILESTONE_MS = 60 * 60 * 1000
const EYE_COMFORT_BASELINE_BPM = 15
const EYE_COMFORT_WINDOW_MS = 45_000
const EYE_COMFORT_GRACE_MS = 7_000
const EYE_COMFORT_EMA_ALPHA = 0.18
const EYE_COMFORT_DECAY_K = 1.2
const EYE_COMFORT_MAX_DECAY_PER_SEC = 1.6
const EYE_COMFORT_RECOVER_PER_SEC = 0.7
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

function gYaw(T) {
  if (T <= T_YAW_IGNORE_SEC) return 0
  let g = 0
  if (T > T_YAW_IGNORE_SEC) {
    const softEnd = Math.min(T, T_YAW_SOFT_CAP_SEC)
    g += G_YAW_ALPHA * (softEnd - T_YAW_IGNORE_SEC)
  }
  if (T > T_YAW_SOFT_CAP_SEC) {
    g += G_YAW_BETA * Math.min(T - T_YAW_SOFT_CAP_SEC, T_YAW_MED_CAP_SEC - T_YAW_SOFT_CAP_SEC)
  }
  if (T > T_YAW_MED_CAP_SEC) {
    g += G_YAW_GAMMA * (Math.exp((T - T_YAW_MED_CAP_SEC) / G_YAW_LONG_TAU) - 1)
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
  #highScoreSince = null   // timestamp when score first reached ≥ 80; null when below
  #flowMilestone = 0       // 0 = none fired, 1 = 20-min fired, 2 = 60-min fired
  #insightChain = { tier: null, depth: 0, scoreAtFire: 100 }
  #bodyDecks = new Map()  // key → { queue: string[], lastShown: string | null }
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
  /** Seconds accumulated while |yaw| exceeds onset on a single-monitor setup. */
  #tYaw = 0
  /** Active seconds: only increments when calibrated, face present, geometry reliable. */
  #activeSessionSec = 0
  #perclosBuf = []
  // Last smoothed frame values for score components + high-level bars.
  #lastPitch = 0
  #lastRoll = 0
  #lastYaw = 0
  #lastLip = 0
  #lastLookUp = 0
  #lastHasMultipleMonitors = false
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
      tYaw: this.#tYaw,
      rawScore: this.#rawScore,
      perclos: this.#perclosFraction(),
      activeSessionMin: this.#activeSessionSec / 60,
    }
  }

  #scoreComponents(perclos, pitch, roll, yaw, lip, lookUp, hasMultipleMonitors) {
    const pg = poseGraceFromYaw(Math.abs(yaw))
    const gate = eyeGateMul(perclos)

    const phoneBad = clamp01(fPitch(pitch) * pg * gPhone(this.#tOff, perclos) * gate)
    const yawBad = hasMultipleMonitors ? 0 : clamp01(gYaw(this.#tYaw) * gate)

    // Energy: full PERCLOS range, no artificial floor or cap.
    const perclosEnergy = clamp01(
      (perclos - ENERGY_PERCLOS_GRACE) / (1 - ENERGY_PERCLOS_GRACE),
    )
    const energyBad = clamp01(perclosEnergy)
    const eyeComfortScore = Math.max(0, Math.min(100, this.#eyeComfortScore))
    const engagementScore = 100 * (1 - clamp01(phoneBad + yawBad))
    const energyScore = 100 * (1 - energyBad)
    const combinedScore = (eyeComfortScore + engagementScore + energyScore) / 3

    return {
      eyeComfort: Math.round(eyeComfortScore),
      engagement: Math.round(engagementScore),
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
      this.#lastHasMultipleMonitors,
    )

    return {
      eyeComfort: parts.eyeComfort,
      engagement: parts.engagement,
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
    hasMultipleMonitors = false,
  }) {
    const now = Date.now()

    if (!facePresent) {
      this.#stableFrames = 0
      this.#perclosBuf = []
      this.#tOff = 0
      this.#tRoll = 0
      this.#tLook = 0
      this.#tYaw = 0
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
      this.#tYaw = 0
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
    this.#lastHasMultipleMonitors = hasMultipleMonitors

    if (this.#calibrated) this.#activeSessionSec += dtSec

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
      this.#integrateTYaw(
        dtSec,
        yawSmoothed,
        concentrationFrameTrusted,
        ear,
        hasMultipleMonitors,
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

    if (this.score >= 80) {
      if (!this.#highScoreSince) this.#highScoreSince = now
    } else {
      this.#highScoreSince = null
      if (this.score < 70) this.#flowMilestone = 0
    }

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

  #integrateTYaw(dtSec, yaw, trusted, ear, hasMultipleMonitors) {
    if (hasMultipleMonitors) {
      this.#tYaw = Math.max(0, this.#tYaw - dtSec * T_YAW_DECAY_PER_SEC)
      return
    }
    const eyesOpenish = ear >= EAR_THRESHOLD - 0.02
    const yawClocking = Math.abs(yaw) >= T_YAW_ONSET_NORM

    if (yawClocking && trusted && eyesOpenish) {
      this.#tYaw += dtSec
    } else if (!yawClocking) {
      this.#tYaw = Math.max(0, this.#tYaw - dtSec * T_YAW_DECAY_PER_SEC)
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
      this.#lastHasMultipleMonitors,
    )
    const activeMin = this.#activeSessionSec / 60
    const decay = Math.exp(-Math.pow(activeMin / SESSION_DECAY_TAU_MIN, SESSION_DECAY_BETA))
    this.#rawScore = Math.min(100, Math.max(0, combinedScore * decay))
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

  #pickBody(key, options) {
    let deck = this.#bodyDecks.get(key)
    if (!deck) {
      deck = { queue: [], lastShown: null }
      this.#bodyDecks.set(key, deck)
    }
    if (deck.queue.length === 0) {
      const pool = options.length > 1 && deck.lastShown
        ? options.filter(o => o !== deck.lastShown)
        : options.slice()
      deck.queue = shuffle(pool)
    }
    const body = deck.queue.pop()
    deck.lastShown = body
    return body
  }

  #scoreTier(s) {
    if (s < 35) return 'break'
    if (s < 55) return 'slipping'
    if (s >= 80) return 'good'
    return 'ok'
  }

  #maybeFireInsight(now) {
    if (this.isCalibrating) return

    const cooldown = this.#escalatingCooldown(now)
    if (now - this.#lastNotifyTs < cooldown) return

    const insight = this.#buildInsight(now)
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

  /** Allow a shorter cooldown when the score is actively worsening. */
  #escalatingCooldown(now) {
    const chain = this.#insightChain
    if (
      chain.tier !== null &&
      this.score < chain.scoreAtFire - 12 &&
      this.#scoreTier(this.score) !== 'ok' &&
      this.#scoreTier(this.score) !== 'good'
    ) {
      return NOTIFY_COOLDOWN_MS * 0.6   // ~3 min when things are getting worse
    }
    return NOTIFY_COOLDOWN_MS
  }

  #buildInsight(now) {
    const tier = this.#scoreTier(this.score)
    const chain = this.#insightChain
    const prevTier = chain.tier

    // ── Flow / milestone ────────────────────────────────────────────────────
    if (tier === 'good' && this.#highScoreSince) {
      const highFor = now - this.#highScoreSince
      if (highFor >= FOCUS_MILESTONE_MS && this.#flowMilestone < 2) {
        this.#flowMilestone = 2
        this.#insightChain = { tier: 'good', depth: 2, scoreAtFire: this.score }
        return {
          title: 'An hour in the zone',
          body: this.#pickBody('good-60', [
            'Seriously impressive. Take a real 10-minute break — move, hydrate, and you will come back just as sharp.',
            "That's a full hour of deep work — most people can't sustain that. Protect the streak with a proper break before the next round.",
            'An hour of real focus is rare. Reward it with 10 minutes completely away from your screen — your brain has earned it.',
            "You've been in flow for an hour. A 10-minute break now resets your cognitive resources for another strong session.",
            'One hour down. A real break now — not just scrolling — keeps your performance high for the rest of the day.',
          ]),
        }
      }
      const FLOW_ONSET_MS = 20 * 60 * 1000
      if (highFor >= FLOW_ONSET_MS && this.#flowMilestone < 1) {
        this.#flowMilestone = 1
        this.#insightChain = { tier: 'good', depth: 1, scoreAtFire: this.score }
        return {
          title: "You're in flow",
          body: this.#pickBody('good-20', [
            "20 minutes of solid focus — you're in the zone. Keep the momentum going.",
            "Flow state locked in. Distractions off, you're doing great — ride this out.",
            "You've been locked in for 20 minutes straight. This is the good stuff.",
            "That's a clean 20-minute stretch. You're in it — don't break the spell.",
          ]),
        }
      }
    }

    // ── Recovery ────────────────────────────────────────────────────────────
    if (
      (prevTier === 'break' || prevTier === 'slipping') &&
      this.score >= 70
    ) {
      this.#insightChain = { tier: 'ok', depth: 0, scoreAtFire: this.score }
      return {
        title: 'Back in it',
        body: this.#pickBody('recovery', [
          'Solid recovery — whatever you just did, it worked. Keep that in your toolkit.',
          "Score's back up after that dip. Good to see you back in the zone.",
          "That's a proper comeback. You're back on track — nice work.",
          'You pulled it back. That kind of reset is what keeps long sessions productive.',
        ]),
      }
    }

    // ── Negative tiers ───────────────────────────────────────────────────────
    if (tier === 'ok' || tier === 'good') return null

    const isEscalation = prevTier === 'slipping' && tier === 'break'
    const isSameTier = prevTier === tier
    const depth = isSameTier ? chain.depth + 1 : 1

    this.#insightChain = { tier, depth, scoreAtFire: this.score }

    if (tier === 'break') {
      if (isEscalation) {
        return {
          title: 'Things slipped further',
          body: this.#pickBody('break-escalation', [
            "It dropped further since the last nudge. The fastest way back is physical — stand up, walk around for two minutes, then return. Movement works better than willpower here.",
            "Gone from drifting to a real dip. Splashing cold water on your face or wrists triggers a reflex that slows your heart rate and brings focus back. Worth trying before a longer break.",
            "The slide continued. A 10-minute break raises your baseline back to where it needs to be — staying put and grinding through it usually makes the next hour worse, not better.",
          ]),
        }
      }
      if (depth === 1) {
        return {
          title: 'Time for a break',
          body: this.#pickBody('break-1', [
            'Get up and move for 2 minutes — even light movement raises the chemicals your brain needs to refocus. Walking to refill your water counts.',
            'Look at something far away for 20 seconds, then close your eyes for 30. This clears the visual processing load your brain has been carrying.',
            'Take 5 breaths where your exhale is twice as long as your inhale. It activates your parasympathetic system and resets your mental baseline quickly.',
            'Step outside for a couple of minutes if you can. Natural light and a change of scene are two of the most effective attention restorers — the research is pretty consistent on this.',
            'Stand up, stretch your arms overhead, and drink a full glass of water. Hydration and posture are two things that directly affect how clearly your brain runs.',
          ]),
        }
      }
      if (depth === 2) {
        return {
          title: 'Still need that break',
          body: this.#pickBody('break-2', [
            "Still in the red. A 10-20 minute break produces more total output than pushing through — your brain after a real rest will outperform your brain right now.",
            "Score hasn't moved. Walk somewhere, look out a window for a minute — even brief exposure to a natural view measurably restores directed attention.",
            "Two check-ins at this level. Your brain's focus systems need time fully offline — two minutes with no screen, no phone, no input. It's more restorative than it feels like it should be.",
          ]),
        }
      }
      return {
        title: 'Your brain is asking nicely',
        body: this.#pickBody('break-3', [
          "A few check-ins deep and still here. A real 10-minute break — no screen — will produce more in the next hour than staying put right now. That's not a guess, that's consistently what the data shows.",
          "Sustained low focus burns through more energy than it generates. Step away properly — if you can fit in a 10-20 minute nap, it improves subsequent focus more than caffeine for most people.",
          "You've been in the red long enough that willpower isn't the lever anymore. Your brain needs input — water, movement, or rest. Pick one and do it for real.",
        ]),
      }
    }

    // tier === 'slipping'
    if (depth === 1) {
      return {
        title: 'Concentration slipping',
        body: this.#pickBody('slipping-1', [
          'Close any extra tabs and flip your phone face-down. Even having your phone visible quietly drains working memory — out of sight genuinely helps.',
          'Sit up straight and look directly at your screen. Upright posture signals alertness to your brain and the score will start climbing back.',
          'Try the 4-7-8 breath: inhale for 4 seconds, hold for 7, exhale for 8. It interrupts scattered thinking and shifts your brain back into focus mode in under a minute.',
          'Look at something at least 20 feet away for 20 seconds. It cuts eye strain and gives your visual system a micro-reset — both help attention come back.',
        ]),
      }
    }
    if (depth === 2) {
      return {
        title: 'Still drifting',
        body: this.#pickBody('slipping-2', [
          "Still slipping since the last check-in. Try a slow exhale that's twice as long as your inhale — it activates the vagus nerve and brings focus back faster than it sounds.",
          "Drink a glass of water right now. Even mild dehydration quietly degrades concentration — it's one of the fastest and most overlooked fixes.",
          "Stand up and move around for 60 seconds. A short burst of movement spikes the chemicals your brain uses to stay sharp, and the score usually follows.",
        ]),
      }
    }
    return {
      title: 'Hanging in there?',
      body: this.#pickBody('slipping-3', [
        "You've been drifting for a while now. A proper 10-minute break — no screen, no scrolling — restores more attentional capacity than pushing through. That's the trade worth making.",
        'Your brain tires like a muscle. A short walk, even just to the kitchen and back, is one of the most effective cognitive resets — more than caffeine for most people at this stage.',
        'Persistent drift usually means glucose or hydration is running low. Drink water, grab a small snack, and step away for two minutes. Simple, but it works.',
      ]),
    }
  }
}
