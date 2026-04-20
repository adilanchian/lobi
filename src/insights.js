// insights.js — Focus score (0–100) from neurogaze.txt: T_off / T_roll tiers, f(P)·g(T_off),
// rollSeverity·gRoll(T_roll), EyeGate (PERCLOS proxy), asymmetric drop/recover, warmup.

import {
  BAD_SIGNAL_THRESHOLD,
  BLINK_SPIKE_BASE,
  BLINK_SPIKE_CAP,
  BLINK_SPIKE_PER_MS,
  CALIBRATION_FRAMES,
  DISPLAY_SCORE_SMOOTH,
  EAR_THRESHOLD,
  EYE_BLEND_MIN,
  EYE_GATE_MIN,
  F_PITCH_SOFT,
  G_PHONE_ALPHA,
  G_PHONE_BETA,
  G_PHONE_GAMMA,
  G_PHONE_LONG_TAU,
  G_ROLL_ALPHA,
  G_ROLL_BETA,
  G_ROLL_GAMMA,
  G_ROLL_LONG_TAU,
  GOOD_SIGNAL_THRESHOLD,
  HEAD_PITCH_OFF_POS,
  HEAD_ROLL_OFF_RAD,
  HEAD_YAW_POSE_GRACE_END,
  HEAD_YAW_POSE_GRACE_START,
  PERCLOS_WINDOW,
  ROLL_SEV_SPAN_RAD,
  SCORE_DROP_PER_SEC,
  SCORE_RECOVER_PER_SEC,
  SCORE_TICK_HZ,
  T_OFF_DECAY_PER_SEC,
  T_OFF_IGNORE_SEC,
  T_OFF_MED_CAP_SEC,
  T_OFF_SOFT_CAP_SEC,
  T_ROLL_DECAY_PER_SEC,
  T_ROLL_IGNORE_SEC,
  T_ROLL_MED_CAP_SEC,
  T_ROLL_SOFT_CAP_SEC,
  W_LOOK_UP,
  W_PERCLOS_DIRECT,
  W_YAWN,
  WARMUP_PENALTY_MULT,
  WARMUP_SEC,
  YAWN_LIP_THRESHOLD,
} from './neurogaze-config.js'

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]

const NOTIFY_COOLDOWN_MS = 5 * 60 * 1000
const FOCUS_MILESTONE_MS = 60 * 60 * 1000
const FACE_ABSENT_PAUSE_MS = 30 * 1000

const PEAK_THRESHOLD = 82
const PEAK_SUSTAIN_MS = 8 * 60 * 1000
const PEAK_NOTIFY_COOLDOWN_MS = 30 * 60 * 1000

const DIP_PEAK_FLOOR = 82
const DIP_SCORE_UPPER = 78
const DIP_SCORE_LOWER = 55
const DIP_NOTIFY_COOLDOWN_MS = 20 * 60 * 1000

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

function warmupPenaltyScale(sessionStartMs, nowMs) {
  const u = Math.min(1, (nowMs - sessionStartMs) / 1000 / WARMUP_SEC)
  return WARMUP_PENALTY_MULT + (1 - WARMUP_PENALTY_MULT) * u
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
  #lastPeakNotifyTs = 0
  #lastDipNotifyTs = 0
  #peakStreakSince = null
  #recentPeakScore = 0
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
  #perclosBuf = []
  #lastFaceTs = Date.now()
  #pausedSince = null
  #lastPitch = 0
  #lastRoll = 0
  #lastYaw = 0
  #lastLip = 0
  #lastLookUp = 0

  get sessionMinutes() {
    return Math.floor((Date.now() - this.#sessionStart) / 60_000)
  }

  get isCalibrating() {
    return !this.#calibrated
  }

  get isPaused() {
    return this.#pausedSince !== null
  }

  /** Snapshot for live dashboard bars (call after `update`). */
  getLiveMetrics() {
    return {
      tOff: this.#tOff,
      tRoll: this.#tRoll,
      rawScore: this.#rawScore,
      perclos: this.#perclosFraction(),
    }
  }

  /**
   * Human-readable 0-100 scores for the default dashboard panel.
   * Buckets match the engine's own #dominantLowScoreSignal so the targeted
   * insight copy ("Rest your eyes", "Bring gaze to screen", etc.) stays
   * coherent with whichever bar is lowest.
   *
   * Yaw is a *grace* signal (poseGrace fades pitch/roll penalties on
   * ultrawide / multi-monitor setups) — never a direct penalty.
   */
  getHighLevelScores() {
    const perclos = this.#perclosFraction()
    const pg = poseGraceFromYaw(Math.abs(this.#lastYaw))
    const gate = eyeGateMul(perclos)

    // Eye Comfort — PERCLOS direct (fraction of frames with EAR < EAR_THRESHOLD
    // over a ~2 s window). 0% closed → 100, 40%+ closed → 0.
    const eyeComfort = Math.round(100 * clamp01(1 - perclos / 0.40))

    // Engagement — the engine's "phone-down" term:
    //   fPitch(pitch) · poseGrace · gPhone(T_off, perclos) · eyeGate
    // Short glances return ~0 (T_off ignore window) by design; sustained
    // chin-down accrues T_off and drags the bar down through the gPhone tiers.
    const phoneBad = clamp01(fPitch(this.#lastPitch) * pg * gPhone(this.#tOff, perclos) * gate)
    const engagement = Math.round(100 * (1 - phoneBad))

    // Posture — max over head tilt (rollSev · poseGrace · gRoll(T_roll) · gate),
    // yawn (W_YAWN · yawnSev), and look-up/ceiling gaze (W_LOOK_UP · lookUpSev).
    // Matches the posture bucket in #dominantLowScoreSignal.
    const rollW = rollSeverity(this.#lastRoll) * pg * gRoll(this.#tRoll) * gate
    const yawnP = yawnSeverity(this.#lastLip)
    const lookP = lookUpSeverity(this.#lastLookUp)
    const postBad = clamp01(Math.max(rollW, W_YAWN * yawnP, W_LOOK_UP * lookP))
    const posture = Math.round(100 * (1 - postBad))

    // Stamina — engine's own ramp: sev ramps 0→0.55 over minutes 45→90, then caps.
    // Additional fatigue drag from PERCLOS and yawn so drowsy long sessions
    // show up as worse than merely-long fresh ones.
    const mins = this.sessionMinutes
    const staminaSev = mins >= 45 ? Math.min(0.55, (mins - 45) / 45) : 0
    let stamina = 100 * (1 - staminaSev) - perclos * 40 - yawnP * 15
    stamina = Math.max(0, Math.min(100, stamina))

    return { eyeComfort, engagement, posture, stamina: Math.round(stamina) }
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
      this.#tickDebt = 0

      // Preserve the main-branch pause behavior so away time does not age the
      // session, while still clearing Andrew's live neurogaze accumulators.
      if (
        this.#pausedSince === null &&
        now - this.#lastFaceTs >= FACE_ABSENT_PAUSE_MS
      ) {
        this.#pausedSince = this.#lastFaceTs + FACE_ABSENT_PAUSE_MS
      }

      if (this.isPaused) this.status = 'Paused'
      else if (this.#calibrated) this.status = 'Away'
      else this.status = 'Waiting for face...'

      this.#pushDisplay()
      return this.score
    }

    if (this.#pausedSince !== null) {
      const pausedDuration = now - this.#pausedSince
      this.#sessionStart += pausedDuration
      this.#goodFocusSince += pausedDuration
      if (this.#peakStreakSince !== null) this.#peakStreakSince += pausedDuration
      if (this.#lastNotifyTs) this.#lastNotifyTs += pausedDuration
      if (this.#lastPeakNotifyTs) this.#lastPeakNotifyTs += pausedDuration
      if (this.#lastDipNotifyTs) this.#lastDipNotifyTs += pausedDuration
      this.#pausedSince = null
      this.#lastUpdateTs = now
      this.#tickDebt = 0
    }
    this.#lastFaceTs = now

    if (!geometryReliable) {
      this.#perclosBuf = []
      this.#tOff = 0
      this.#tRoll = 0
      this.#tickDebt = 0
      this.#lastUpdateTs = now
      this.status = "Can't see face clearly"
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
    }

    const perclos = this.#perclosFraction()

    if (this.#calibrated && concentrationFrameTrusted) {
      this.#tickDebt += dtSec
      const maxSteps = 4
      let steps = 0
      const penScale = warmupPenaltyScale(this.#sessionStart, now)

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
          penScale,
        )
      }
    }

    if (blinkJustCompleted && this.#calibrated && concentrationFrameTrusted) {
      const sp = Math.min(
        BLINK_SPIKE_CAP,
        BLINK_SPIKE_BASE + lastCompletedBlinkDurationMs * BLINK_SPIKE_PER_MS,
      )
      this.#rawScore = Math.min(
        100,
        Math.max(
          0,
          this.#rawScore - sp * warmupPenaltyScale(this.#sessionStart, now),
        ),
      )
    }

    this.#pushDisplay()

    if (this.isCalibrating) this.status = 'Calibrating...'
    else if (this.score >= 80) this.status = 'Locked In'
    else if (this.score >= 65) this.status = 'Focused'
    else if (this.score >= 50) this.status = 'Drifting'
    else if (this.score >= 35) this.status = 'Low Focus'
    else this.status = 'Need a Break'

    if (this.score < 70) this.#goodFocusSince = now

    if (this.score < DIP_SCORE_LOWER) {
      this.#recentPeakScore = 0
      this.#peakStreakSince = null
    } else {
      this.#recentPeakScore = Math.max(this.#recentPeakScore, this.score)
      if (this.score >= PEAK_THRESHOLD) {
        if (this.#peakStreakSince === null) this.#peakStreakSince = now
      } else {
        this.#peakStreakSince = null
      }
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

  #scoreTick(perclos, pitch, roll, yaw, lip, lookUp, penScale) {
    const pg = poseGraceFromYaw(Math.abs(yaw))
    const fp = fPitch(pitch) * pg
    const g = gPhone(this.#tOff, perclos)
    const rollS = rollSeverity(roll) * pg
    const gr = gRoll(this.#tRoll)
    const rollWeighted = rollS * gr
    const gate = eyeGateMul(perclos)
    const headTerm = (fp * g + rollWeighted) * gate

    const y = yawnSeverity(lip)
    const u = lookUpSeverity(lookUp)

    const bad = clamp01(
      headTerm + W_YAWN * y + W_LOOK_UP * u + W_PERCLOS_DIRECT * perclos,
    )

    const forward = (1 - fp * 0.92) * (1 - rollWeighted * 0.9)
    const auxClear = (1 - y * 0.85) * (1 - u * 0.85)
    const good = clamp01(forward * auxClear * (perclos < 0.35 ? 1 : 1 - perclos))

    if (bad > BAD_SIGNAL_THRESHOLD) {
      this.#rawScore -= SCORE_DROP_PER_SEC * bad * penScale * TICK_SEC
    } else if (good > GOOD_SIGNAL_THRESHOLD) {
      this.#rawScore +=
        SCORE_RECOVER_PER_SEC * good * (100 - this.#rawScore) * TICK_SEC
    }

    this.#rawScore = Math.min(100, Math.max(0, this.#rawScore))
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

  #dominantLowScoreSignal(perclos) {
    const pg = poseGraceFromYaw(Math.abs(this.#lastYaw))
    const phone =
      fPitch(this.#lastPitch) * pg * gPhone(this.#tOff, perclos) * eyeGateMul(perclos)
    const roll =
      rollSeverity(this.#lastRoll) *
      pg *
      gRoll(this.#tRoll) *
      eyeGateMul(perclos)
    const posture = Math.max(
      roll,
      W_YAWN * yawnSeverity(this.#lastLip),
      W_LOOK_UP * lookUpSeverity(this.#lastLookUp),
    )
    const eyeComfort = W_PERCLOS_DIRECT * perclos
    const stamina =
      this.sessionMinutes >= 45 ? Math.min(0.55, (this.sessionMinutes - 45) / 45) : 0

    return [
      ['eyeComfort', eyeComfort],
      ['phoneDown', phone],
      ['posture', posture],
      ['stamina', stamina],
    ].sort((a, b) => b[1] - a[1])[0][0]
  }

  #maybeFireInsight(now) {
    if (this.isCalibrating) return
    if (now - this.#lastNotifyTs < NOTIFY_COOLDOWN_MS) return

    const focusedFor = now - this.#goodFocusSince
    const perclos = this.#perclosFraction()

    let insight = null

    if (this.score < 35) {
      insight = {
        title: 'Time for a break 🧠',
        body: pick([
          'Step away, take a few deep breaths, and look at something far away. Two minutes is all it takes to recharge.',
          'Get up, refill your water, and walk around for 2 minutes. Your brain restores faster when your body moves.',
          'Close your eyes for 30 seconds, then take a short walk. Even micro-breaks reset your ability to concentrate.',
          'Stand up, stretch your arms overhead, and look out a window. A real pause, even a quick one, beats pushing through.',
          'Your brain has been working hard. Two minutes of doing nothing is surprisingly powerful. Step away from the screen.',
        ]),
      }
    } else if (this.score < 55) {
      const targeted = {
        eyeComfort: {
          title: 'Rest your eyes 👁',
          body: pick([
            'Look at something at least 20 feet away for 20 seconds. Letting your eye muscles fully relax prevents the slow drain that builds up over hours.',
            'Blink slowly 10 times, then focus on something in the distance. Staring at a screen suppresses blinking, which dries your eyes faster than you notice.',
            'Cover your eyes with your palms for 30 seconds with no light and no screen. It is one of the fastest ways to reduce eye fatigue.',
            'Look out a window and let your eyes adjust to natural distance. Your eye muscles have been locked at the same focal length for a while.',
            'Take 20 seconds to look far away and do a few slow blinks. A little deliberate rest goes a long way for recovery.',
          ]),
        },
        phoneDown: {
          title: 'Hard to focus? 👀',
          body: pick([
            'Bring your gaze back to screen height and let it stay there for a minute. Longer phone-down stretches pull the score down more than quick glances.',
            'Face the camera again and level your head. The score climbs back gradually once steady forward attention returns.',
            'If you just checked your phone, finish the check and put it away. Stop-start glances cost more than a clean return to the task.',
            'Lift your chin a little and keep your eyes forward for a minute. Recovery is gradual once the off-task posture clears.',
            'Good lighting and a level head help the model tell a quick glance from a longer drift. Reset your posture and lock back in.',
          ]),
        },
        posture: {
          title: 'Time for a reset 🪑',
          body: pick([
            'Roll your shoulders back, level your head, and unclench your jaw. Physical tension and mental fatigue feed each other.',
            'Sit up tall, put both feet flat on the floor, and take three deep breaths. Your posture signals your brain whether to be alert or tired.',
            'Take 30 seconds to stretch your neck slowly side to side. Tension there quietly drains your energy.',
            'Check in with your body. Are you hunching, tilting your head, or holding your breath? Relax each one intentionally.',
            'Stand up for 60 seconds and shake out your hands. Sustained sitting and head tilt slowly chip away at alertness.',
          ]),
        },
        stamina: {
          title: `${this.sessionMinutes} minutes in ⏱`,
          body: pick([
            'A short break now compounds. Five minutes off the screen extends your next focus window significantly.',
            'The best time to take a break is before you feel like you need one. Step away now and come back stronger.',
            'Your brain runs in natural focus cycles. A short reset now keeps the next one just as sharp.',
            'Hydrate, stand up, and give your eyes a rest. Those three together are the fastest recovery combo.',
          ]),
        },
      }
      insight = targeted[this.#dominantLowScoreSignal(perclos)]
    } else if (
      this.score >= DIP_SCORE_LOWER &&
      this.score < DIP_SCORE_UPPER &&
      this.#recentPeakScore >= DIP_PEAK_FLOOR &&
      now - this.#lastDipNotifyTs >= DIP_NOTIFY_COOLDOWN_MS
    ) {
      insight = {
        title: 'Focus is slipping 🌊',
        body: pick([
          'Your focus is starting to dip. Look at something about 20 feet away for 20 seconds.',
          'Mental fatigue is rising. Close your eyes and do 10 slow breaths with a long exhale.',
          'You are starting to drift. Stand up for 30 seconds. A quick reset keeps the streak alive.',
          'Focus is trending down. Sip some water and roll your shoulders back before the dip deepens.',
          'Early fatigue signals. Look out a window for 20 seconds and let your eyes release.',
        ]),
      }
      this.#lastDipNotifyTs = now
    } else if (focusedFor > FOCUS_MILESTONE_MS && this.score >= 80) {
      insight = {
        title: 'An hour in the zone 🔥',
        body: pick([
          'Seriously impressive. Take a real 10-minute break, move, hydrate, and you will come back just as sharp.',
          "That's a full hour of deep work. Most people cannot sustain that. Protect the streak with a proper break before the next round.",
          'An hour of real focus is rare. Reward it with 10 minutes completely away from your screen. Your brain has earned it.',
          'You have been in flow for an hour. A 10-minute break now resets your cognitive resources for another strong session.',
          'One hour down. A real break now, not just scrolling, keeps your performance high for the rest of the day.',
        ]),
      }
    } else if (
      this.#peakStreakSince !== null &&
      now - this.#peakStreakSince >= PEAK_SUSTAIN_MS &&
      now - this.#lastPeakNotifyTs >= PEAK_NOTIFY_COOLDOWN_MS
    ) {
      insight = {
        title: 'Locked in 🔥',
        body: pick([
          'You are in a peak focus window right now. Silence notifications and start a 25-minute deep work block.',
          'Your focus is locked in. Protect this window, silence notifications, and batch your hardest task now.',
          'Deep focus engaged. This is the moment to tackle the thing you have been putting off.',
          'You are running hot. Ride the wave and commit to 25 uninterrupted minutes on your highest-value task.',
          'Peak focus detected. Block the next 25 minutes, close every other tab, and go.',
        ]),
      }
      this.#lastPeakNotifyTs = now
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
