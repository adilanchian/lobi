/**
 * Notification system tests for InsightEngine.
 *
 * Strategy: drive InsightEngine.update() with synthetic frame sequences,
 * using vi.useFakeTimers() to warp time and capture fired insights via
 * the 'lobi-insight' CustomEvent.
 *
 * Why ear:0.19 for the bad frame:
 *   - Below EAR_THRESHOLD (0.2) → PERCLOS counts it as closed → energy→0
 *   - ≥ EAR_THRESHOLD-0.02 (0.18) → integrateTOff treats eyes as "openish" → T_off accumulates
 *   Both components drop simultaneously, which is what it takes to pull the combined
 *   score (average of eyeComfort + engagement + energy) below the slipping/break threshold.
 */

import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { InsightEngine } from './insights.js'

// ─── Browser API stubs ───────────────────────────────────────────────────────

const firedInsights = []

global.window = {
  lobi: { sendInsight: vi.fn() },
  dispatchEvent: (e) => { firedInsights.push(e.detail) },
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
}

global.CustomEvent = class CustomEvent {
  constructor(type, opts) { this.type = type; this.detail = opts?.detail }
}

// ─── Frame definitions ───────────────────────────────────────────────────────

/** Normal focused working frame — score stays near 100. */
const GOOD_FRAME = {
  facePresent: true,
  ear: 0.3,
  pitchSmoothed: 0,
  rollRadSmoothed: 0,
  yawSmoothed: 0,
  chinDown: false,
  lipNormSmoothed: 0,
  lookUpNormSmoothed: 0,
  geometryReliable: true,
  concentrationFrameTrusted: true,
  blinkJustCompleted: false,
  lastCompletedBlinkDurationMs: 0,
  hasMultipleMonitors: false,
}

const AWAY_FRAME = { facePresent: false }

/**
 * "Phone check" distraction frame.
 * ear:0.19 is dual-purpose: below EAR_THRESHOLD (0.2) so PERCLOS fills, but
 * above the integrateTOff eyesOpenish threshold (0.18) so T_off also accumulates.
 * ~1000 frames (~67 s) reliably drives score into break tier.
 */
const BAD_FRAME = {
  ...GOOD_FRAME,
  chinDown: true,
  pitchSmoothed: 0.28, // above HEAD_PITCH_OFF_POS (0.24) → fPitch = 1
  ear: 0.19,
}

/**
 * Recovery frame — no distraction, blinks every frame.
 * Blink rate >> baseline so eyeComfort deficit = 0 and it recovers at 0.7/s.
 */
const RECOVERY_FRAME = {
  ...GOOD_FRAME,
  blinkJustCompleted: true,
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Feed n frames with realistic 67 ms inter-frame timing.
 * vi.advanceTimersByTime advances Date.now() so the engine's dtSec calculation works.
 */
function feedFrames(engine, frame, n, dtMs = 67) {
  for (let i = 0; i < n; i++) {
    vi.advanceTimersByTime(dtMs)
    engine.update(frame)
  }
}

/** Calibrate the engine (needs 30 reliable frames; 35 gives a small buffer). */
function calibrate(engine) {
  feedFrames(engine, GOOD_FRAME, 35)
}

/**
 * Push score into break tier (~67 s of dual-signal bad frames).
 * Also advances fake time by that amount, so a subsequent cooldown advance is relative.
 */
function driveToBreak(engine) {
  feedFrames(engine, BAD_FRAME, 1000)
}

/**
 * Recover score to ~100 and advance past cooldown.
 * 2000 recovery frames (~134 s) + 6 min advance clears T_off, PERCLOS, eyeComfort,
 * and expires the 5-min notification cooldown.
 */
function recover(engine) {
  feedFrames(engine, RECOVERY_FRAME, 2000)
  vi.advanceTimersByTime(6 * 60 * 1000)
  feedFrames(engine, RECOVERY_FRAME, 10)
}

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers()
  firedInsights.length = 0
  window.lobi.sendInsight.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

// ── 1. No notification while calibrating ────────────────────────────────────
describe('calibration gate', () => {
  it('does not fire any insight during calibration', () => {
    const engine = new InsightEngine()
    feedFrames(engine, GOOD_FRAME, 29) // one short of calibration threshold
    expect(firedInsights).toHaveLength(0)
  })
})

// ── 2. No notification when face is absent ──────────────────────────────────
describe('face-absent gate', () => {
  it('does not fire when face is away the whole time', () => {
    const engine = new InsightEngine()
    feedFrames(engine, AWAY_FRAME, 200)
    expect(firedInsights).toHaveLength(0)
  })

  it('does not fire negative insights right after returning to good posture', () => {
    const engine = new InsightEngine()
    calibrate(engine)
    vi.advanceTimersByTime(6 * 60 * 1000)
    feedFrames(engine, AWAY_FRAME, 50)
    firedInsights.length = 0

    feedFrames(engine, GOOD_FRAME, 10)

    const negTitles = ['Concentration slipping', 'Still drifting', 'Time for a break',
      'Still need that break']
    expect(firedInsights.filter(i => negTitles.includes(i.title))).toHaveLength(0)
  })
})

// ── 3. Cooldown is respected ─────────────────────────────────────────────────
describe('cooldown', () => {
  it('does not fire a second notification within 5 minutes', () => {
    const engine = new InsightEngine()
    calibrate(engine)
    driveToBreak(engine)

    // Verify at least one notification fired
    const countAfterFirst = firedInsights.length
    expect(countAfterFirst).toBeGreaterThanOrEqual(1)

    // Advance only 1 minute — within even the reduced (3 min) escalating cooldown
    vi.advanceTimersByTime(1 * 60 * 1000)
    feedFrames(engine, BAD_FRAME, 100)

    expect(firedInsights.length).toBe(countAfterFirst)
  })

  it('does fire again after cooldown expires', () => {
    const engine = new InsightEngine()
    calibrate(engine)
    driveToBreak(engine)

    const countAfterFirst = firedInsights.length
    expect(countAfterFirst).toBeGreaterThanOrEqual(1)

    // Advance past the 5-minute cooldown
    vi.advanceTimersByTime(6 * 60 * 1000)
    feedFrames(engine, BAD_FRAME, 50)

    expect(firedInsights.length).toBeGreaterThan(countAfterFirst)
  })
})

// ── 4. Score must actually be bad to fire a negative insight ────────────────
describe('score threshold', () => {
  it('does not fire a negative insight when score stays high', () => {
    const engine = new InsightEngine()
    calibrate(engine)
    vi.advanceTimersByTime(6 * 60 * 1000)
    feedFrames(engine, GOOD_FRAME, 200)

    const negTitles = ['Concentration slipping', 'Still drifting', 'Hanging in there?',
      'Time for a break', 'Still need that break', "Your brain is asking nicely",
      'Things slipped further']
    expect(firedInsights.filter(i => negTitles.includes(i.title))).toHaveLength(0)
  })

  it('fires a negative insight after sustained distraction', () => {
    const engine = new InsightEngine()
    calibrate(engine)
    driveToBreak(engine)

    const negTitles = ['Concentration slipping', 'Still drifting', 'Hanging in there?',
      'Time for a break', 'Still need that break', "Your brain is asking nicely",
      'Things slipped further']
    expect(firedInsights.filter(i => negTitles.includes(i.title)).length).toBeGreaterThanOrEqual(1)
  })
})

// ── 5. Escalation: slipping → break ─────────────────────────────────────────
describe('intervention preferences', () => {
  it('uses selected interventions in focus-dip recommendations', () => {
    const engine = new InsightEngine()
    engine.setInterventionPreferences(['coffee'])
    calibrate(engine)
    driveToBreak(engine)

    const negative = firedInsights.find(i => [
      'Concentration slipping',
      'Still drifting',
      'Hanging in there?',
      'Time for a break',
      'Still need that break',
      'Your brain is asking nicely',
      'Things slipped further',
    ].includes(i.title))

    expect(negative?.body.toLowerCase()).toContain('coffee')
  })
})

describe('escalation', () => {
  it('fires an escalation or break notification when tier worsens', () => {
    const engine = new InsightEngine()
    calibrate(engine)

    // First wave — mild distraction, should land in slipping range
    feedFrames(engine, BAD_FRAME, 200)
    vi.advanceTimersByTime(6 * 60 * 1000)
    feedFrames(engine, BAD_FRAME, 50)

    // Second wave — deeper distraction into break
    vi.advanceTimersByTime(6 * 60 * 1000)
    feedFrames(engine, BAD_FRAME, 1000)
    vi.advanceTimersByTime(6 * 60 * 1000)
    feedFrames(engine, BAD_FRAME, 50)

    const escalationOrBreak = firedInsights.some(
      i => i.title === 'Things slipped further' || i.title === 'Time for a break'
    )
    expect(escalationOrBreak).toBe(true)
  })
})

// ── 6. Recovery notification ────────────────────────────────────────────────
describe('recovery', () => {
  it('fires "Back in it" after recovering from a bad tier', () => {
    const engine = new InsightEngine()
    calibrate(engine)

    // Drive into break and let a notification fire
    driveToBreak(engine)
    expect(firedInsights.length).toBeGreaterThanOrEqual(1)

    // Clear firedInsights so we can spot the recovery message specifically
    firedInsights.length = 0

    // Recover: T_off decays, PERCLOS clears, eyeComfort rebuilds via blinks
    recover(engine)

    const recoveryFired = firedInsights.some(i => i.title === 'Back in it')
    expect(recoveryFired).toBe(true)
  })
})

// ── 7. Flow milestones ───────────────────────────────────────────────────────
describe('flow milestones', () => {
  it('fires "You\'re in flow" after 20 minutes of sustained ≥80 score', () => {
    const engine = new InsightEngine()
    calibrate(engine)

    vi.advanceTimersByTime(21 * 60 * 1000)
    feedFrames(engine, GOOD_FRAME, 10)

    expect(firedInsights.some(i => i.title === "You're in flow")).toBe(true)
  })

  it('fires "An hour in the zone" after 60 minutes of sustained ≥80 score', () => {
    const engine = new InsightEngine()
    calibrate(engine)

    vi.advanceTimersByTime(61 * 60 * 1000)
    feedFrames(engine, GOOD_FRAME, 10)

    expect(firedInsights.some(i => i.title === 'An hour in the zone')).toBe(true)
  })

  it('fires flow milestones only once per streak', () => {
    const engine = new InsightEngine()
    calibrate(engine)

    vi.advanceTimersByTime(21 * 60 * 1000)
    feedFrames(engine, GOOD_FRAME, 10)
    vi.advanceTimersByTime(6 * 60 * 1000)
    feedFrames(engine, GOOD_FRAME, 10)
    vi.advanceTimersByTime(6 * 60 * 1000)
    feedFrames(engine, GOOD_FRAME, 10)

    const flowCount = firedInsights.filter(i => i.title === "You're in flow").length
    expect(flowCount).toBe(1)
  })

  it('resets flow milestone after score drops below 70 and can re-earn it', () => {
    const engine = new InsightEngine()
    calibrate(engine)

    // Earn the 20-min milestone
    vi.advanceTimersByTime(21 * 60 * 1000)
    feedFrames(engine, GOOD_FRAME, 10)
    expect(firedInsights.some(i => i.title === "You're in flow")).toBe(true)

    // Break the streak — score drops below 70 (resets #flowMilestone to 0)
    driveToBreak(engine)

    // Rebuild score and wait for a new 20-min streak
    recover(engine)
    vi.advanceTimersByTime(21 * 60 * 1000)
    feedFrames(engine, GOOD_FRAME, 10)

    const flowCount = firedInsights.filter(i => i.title === "You're in flow").length
    expect(flowCount).toBeGreaterThanOrEqual(2)
  })
})

// ── 8. No-repeat body rotation ───────────────────────────────────────────────
describe('no-repeat body rotation', () => {
  it('never shows the same body back-to-back for the same notification title', () => {
    const engine = new InsightEngine()
    calibrate(engine)

    // Cycle through 8 rounds of bad→good to accumulate many "Concentration slipping" insightss
    for (let round = 0; round < 8; round++) {
      driveToBreak(engine)
      vi.advanceTimersByTime(6 * 60 * 1000)
      feedFrames(engine, BAD_FRAME, 10)
      recover(engine)
    }

    const slippingInsights = firedInsights.filter(i =>
      i.title === 'Concentration slipping' || i.title === 'Time for a break'
    )
    for (let i = 1; i < slippingInsights.length; i++) {
      expect(slippingInsights[i].body).not.toBe(slippingInsights[i - 1].body)
    }
  })
})

// ── 10. Ultradian session decay ──────────────────────────────────────────────
//
// decay = exp( -(activeMin / SESSION_DECAY_TAU_MIN) ^ SESSION_DECAY_BETA )
// TAU=200 min, BETA=2 (Gaussian shape).
//
// Expected values at key milestones:
//   45 min  → 0.9506  (−5%)
//   90 min  → 0.8167  (−18%)   ← end of 1st ultradian cycle, now noticeable
//   120 min → 0.6977  (−30%)
//   180 min → 0.4449  (−56%)
//
// This test suite pins the current behavior so any future constant changes
// produce explicit, reviewable failures rather than silent score shifts.

import {
  SESSION_DECAY_TAU_MIN,
  SESSION_DECAY_BETA,
  BREAK_MIN_DURATION_MS,
  BREAK_FULL_RESET_MS,
  BREAK_SESSION_END_MS,
} from './neurogaze-config.js'

function expectedDecay(activeMin) {
  return Math.exp(-Math.pow(activeMin / SESSION_DECAY_TAU_MIN, SESSION_DECAY_BETA))
}

describe('ultradian session decay — math', () => {
  it('decay is 1.0 at session start (no active time)', () => {
    expect(expectedDecay(0)).toBeCloseTo(1.0, 5)
  })

  it('decay at 45 min is ~0.951 — only 5% reduction (safe to stay focused)', () => {
    expect(expectedDecay(45)).toBeCloseTo(0.9506, 3)
  })

  it('decay at 90 min (end of 1st ultradian cycle) is ~0.817 — 18% reduction', () => {
    expect(expectedDecay(90)).toBeCloseTo(0.8167, 3)
  })

  it('decay at 120 min is ~0.698 — 30% reduction (noticeably past cycle end)', () => {
    expect(expectedDecay(120)).toBeCloseTo(0.6977, 3)
  })

  it('decay at 180 min is ~0.445 — 56% reduction (seriously need a break)', () => {
    expect(expectedDecay(180)).toBeCloseTo(0.4449, 3)
  })

  it('decay is always positive (never reaches zero)', () => {
    expect(expectedDecay(24 * 60)).toBeGreaterThan(0)
  })

  it('decay is monotonically decreasing over time', () => {
    const milestones = [0, 30, 45, 60, 90, 120, 180, 270, 360]
    for (let i = 1; i < milestones.length; i++) {
      expect(expectedDecay(milestones[i])).toBeLessThan(expectedDecay(milestones[i - 1]))
    }
  })

  it('at TAU (120 min) decay = e^-1 ≈ 0.368 — score drops to ~37% of peak', () => {
    expect(expectedDecay(SESSION_DECAY_TAU_MIN)).toBeCloseTo(Math.exp(-1), 5)
  })
})

describe('ultradian session decay — engine integration', () => {
  it('activeSessionSec only accumulates after calibration completes', () => {
    const engine = new InsightEngine()

    // Pre-calibration frames should not count toward active time
    feedFrames(engine, GOOD_FRAME, 10)
    const metrics = engine.getLiveMetrics()
    expect(metrics.activeSessionMin).toBeCloseTo(0, 1)
  })

  it('activeSessionSec does not accumulate while face is absent', () => {
    const engine = new InsightEngine()
    calibrate(engine)

    const before = engine.getLiveMetrics().activeSessionMin

    // Face away for 10 minutes
    vi.advanceTimersByTime(10 * 60 * 1000)
    feedFrames(engine, AWAY_FRAME, 50)

    const after = engine.getLiveMetrics().activeSessionMin
    // Active time should not have jumped by ~10 min
    expect(after - before).toBeLessThan(0.1)
  })

  it('activeSessionSec does not accumulate when geometry is unreliable', () => {
    const engine = new InsightEngine()
    calibrate(engine)

    const before = engine.getLiveMetrics().activeSessionMin
    feedFrames(engine, { ...GOOD_FRAME, geometryReliable: false }, 100)
    const after = engine.getLiveMetrics().activeSessionMin

    expect(after - before).toBeLessThan(0.1)
  })

  it('activeSessionSec accumulates at real-time rate during active use', () => {
    const engine = new InsightEngine()
    calibrate(engine)

    // Feed frames equivalent to ~2 minutes of active work
    feedFrames(engine, GOOD_FRAME, 1800) // 1800 * 67ms ≈ 120.6 s ≈ 2 min

    const activeMin = engine.getLiveMetrics().activeSessionMin
    // Should be close to 2 minutes (allow ±20s tolerance for calibration overhead)
    expect(activeMin).toBeGreaterThan(1.5)
    expect(activeMin).toBeLessThan(2.5)
  })

  it('decay is applied to raw score — score after 3h active is meaningfully lower', () => {
    const engine = new InsightEngine()
    calibrate(engine)

    feedFrames(engine, RECOVERY_FRAME, 10)
    const earlyScore = engine.score

    // 180 min → decay ≈ 0.439, so a score of 100 becomes ~44
    const framesFor3h = Math.round((3 * 60 * 60 * 1000) / 67)
    feedFrames(engine, RECOVERY_FRAME, framesFor3h)

    const lateScore = engine.score
    expect(lateScore).toBeLessThan(earlyScore)
    expect(lateScore).toBeLessThan(earlyScore * 0.65) // at least 35% drop by 3 h
  })

  it('ultradian decay causes ~18% score drop at 90 min (isolated from eyeComfort)', () => {
    const engine = new InsightEngine()
    calibrate(engine)

    // RECOVERY_FRAME keeps eyeComfort saturated so only the decay factor changes
    feedFrames(engine, RECOVERY_FRAME, 10)
    const earlyScore = engine.score

    const framesFor90min = Math.round((90 * 60 * 1000) / 67)
    feedFrames(engine, RECOVERY_FRAME, framesFor90min)

    const scoreAt90min = engine.score

    // Decay at 90 min = 0.8167 → ~18% drop on a perfect score.
    // Display EMA (α=0.92) lags the raw score, so the visible drop is
    // somewhat less than the theoretical maximum but still clearly > 10 pts.
    expect(earlyScore - scoreAt90min).toBeGreaterThan(10)
    expect(earlyScore - scoreAt90min).toBeLessThan(30)
  })
})

// ── 9. Insight payload shape ──────────────────────────────────────────────────
describe('insight payload', () => {
  it('every fired insight has a non-empty title and body string', () => {
    const engine = new InsightEngine()
    calibrate(engine)
    driveToBreak(engine)

    expect(firedInsights.length).toBeGreaterThan(0)
    for (const insight of firedInsights) {
      expect(typeof insight.title).toBe('string')
      expect(insight.title.length).toBeGreaterThan(0)
      expect(typeof insight.body).toBe('string')
      expect(insight.body.length).toBeGreaterThan(0)
    }
  })
})

// ── 11. Break boost ───────────────────────────────────────────────────────────

const sessionEndEvents = []

// Capture lobi-session-end events via the same window.dispatchEvent stub
const _originalDispatch = global.window.dispatchEvent
global.window.dispatchEvent = (e) => {
  if (e.type === 'lobi-session-end') sessionEndEvents.push(e)
  else firedInsights.push(e.detail)
}

// Helper: simulate going away for a set duration and returning.
// Correct sequence: one away frame records #breakStartTs, then time advances,
// then returning face triggers #applyBreakBoost with the full elapsed duration.
function takeBreak(engine, durationMs) {
  engine.update(AWAY_FRAME)           // frame 1: records #breakStartTs = now
  vi.advanceTimersByTime(durationMs)  // time passes
  engine.update(AWAY_FRAME)           // frame 2: updates status/checks session-end
}

function returnFromBreak(engine) {
  vi.advanceTimersByTime(67)
  engine.update(RECOVERY_FRAME)       // face returns → applyBreakBoost fires
}

/**
 * Build up activeSessionSec efficiently.
 * Each frame uses a 500 ms advance which hits the 0.5 s dtSec cap,
 * so `minutes` active time requires minutes*60/0.5 = minutes*120 frames.
 * At ~40 min this is 4800 iterations — fast in Node with no I/O.
 */
function buildActiveTime(engine, minutes) {
  const frames = Math.round(minutes * 120)
  feedFrames(engine, RECOVERY_FRAME, frames, 500)
}

describe('break boost', () => {
  beforeEach(() => { sessionEndEvents.length = 0 })

  it('isOnBreak is false while face is present', () => {
    const engine = new InsightEngine()
    calibrate(engine)
    feedFrames(engine, GOOD_FRAME, 5)
    expect(engine.isOnBreak).toBe(false)
  })

  it('isOnBreak is false immediately after first away frame (break timer just started)', () => {
    const engine = new InsightEngine()
    calibrate(engine)
    engine.update(AWAY_FRAME)  // sets #breakStartTs = now; elapsed = 0
    expect(engine.isOnBreak).toBe(false)
  })

  it('isOnBreak becomes true after 1+ min of continuous absence', () => {
    const engine = new InsightEngine()
    calibrate(engine)
    engine.update(AWAY_FRAME)                       // start break timer
    vi.advanceTimersByTime(BREAK_MIN_DURATION_MS + 1000)
    engine.update(AWAY_FRAME)                       // elapsed now > 1 min
    expect(engine.isOnBreak).toBe(true)
  })

  it('status is "On Break" (not "Away") after 1+ min absence', () => {
    const engine = new InsightEngine()
    calibrate(engine)
    engine.update(AWAY_FRAME)
    vi.advanceTimersByTime(BREAK_MIN_DURATION_MS + 1000)
    engine.update(AWAY_FRAME)
    expect(engine.status).toBe('On Break')
  })

  it('no boost insight fires for absences under 1 min', () => {
    const engine = new InsightEngine()
    calibrate(engine)
    feedFrames(engine, RECOVERY_FRAME, 1000)
    firedInsights.length = 0

    takeBreak(engine, 30_000)  // 30 s — below BREAK_MIN_DURATION_MS
    returnFromBreak(engine)

    const boostInsights = firedInsights.filter(i => i?.title?.includes('boost'))
    expect(boostInsights).toHaveLength(0)
  })

  it('boost insight fires when returning from a 2-minute break', () => {
    const engine = new InsightEngine()
    calibrate(engine)
    buildActiveTime(engine, 40)   // 40 min active → decay measurable
    firedInsights.length = 0

    takeBreak(engine, 2 * 60_000)
    returnFromBreak(engine)

    const boostInsights = firedInsights.filter(i => i?.title?.includes('boost'))
    expect(boostInsights).toHaveLength(1)
    expect(boostInsights[0].title).toMatch(/^\+\d+% focus boost$/)
    expect(boostInsights[0].body).toContain('2-minute break')
  })

  it('partial break (2 min) reduces activeSessionSec but does not fully reset it', () => {
    const engine = new InsightEngine()
    calibrate(engine)
    buildActiveTime(engine, 40)
    const before = engine.getLiveMetrics().activeSessionMin

    takeBreak(engine, 2 * 60_000)
    returnFromBreak(engine)

    const after = engine.getLiveMetrics().activeSessionMin
    expect(after).toBeLessThan(before)   // some reduction
    expect(after).toBeGreaterThan(0)     // not a full reset
  })

  it('full break (≥ 10 min) resets activeSessionSec to zero', () => {
    const engine = new InsightEngine()
    calibrate(engine)
    buildActiveTime(engine, 40)

    takeBreak(engine, BREAK_FULL_RESET_MS + 1000)
    returnFromBreak(engine)

    expect(engine.getLiveMetrics().activeSessionMin).toBeCloseTo(0, 1)
  })

  it('boost percentage is larger for a longer break', () => {
    function runAndGetBoost(breakMs) {
      const e = new InsightEngine()
      calibrate(e)
      buildActiveTime(e, 40)   // 40 min active so decay is measurable
      firedInsights.length = 0
      takeBreak(e, breakMs)
      returnFromBreak(e)
      const insight = firedInsights.find(i => i?.title?.includes('boost'))
      return parseInt(insight?.title ?? '0')
    }

    const shortBoost = runAndGetBoost(2 * 60_000)         // 2 min → partial reset
    firedInsights.length = 0
    const longBoost  = runAndGetBoost(BREAK_FULL_RESET_MS + 1000)  // 10+ min → full reset

    expect(longBoost).toBeGreaterThan(shortBoost)
  })

  it('fires lobi-session-end after 60 min absence', () => {
    const engine = new InsightEngine()
    calibrate(engine)
    feedFrames(engine, RECOVERY_FRAME, 100)

    engine.update(AWAY_FRAME)                             // start break timer
    vi.advanceTimersByTime(BREAK_SESSION_END_MS + 1000)
    engine.update(AWAY_FRAME)                             // triggers session-end

    expect(sessionEndEvents).toHaveLength(1)
    expect(engine.status).toBe('Session ended')
  })

  it('does not fire session-end for absences just under 60 min', () => {
    const engine = new InsightEngine()
    calibrate(engine)

    engine.update(AWAY_FRAME)
    vi.advanceTimersByTime(BREAK_SESSION_END_MS - 5000)
    engine.update(AWAY_FRAME)

    expect(sessionEndEvents).toHaveLength(0)
  })
})

// ── 12. Multi-monitor detection ───────────────────────────────────────────────
//
// When hasMultipleMonitors=true:
//   - T_yaw must never accumulate (user is legitimately looking at another screen)
//   - yawBad must be 0 in score components (no engagement penalty)
//   - T_yaw that built up on single-monitor must actively decay when monitors switch
//
// When hasMultipleMonitors=false (default):
//   - T_yaw accumulates after the T_YAW_IGNORE_SEC (2s) grace period
//   - Sustained high yaw drives engagement score down

import { T_YAW_ONSET_NORM, T_YAW_IGNORE_SEC } from './neurogaze-config.js'

const HIGH_YAW_FRAME = {
  ...GOOD_FRAME,
  yawSmoothed: T_YAW_ONSET_NORM + 0.1,  // clearly past the onset threshold
}

describe('multi-monitor — T_yaw suppression', () => {
  it('T_yaw does not accumulate on a multi-monitor setup', () => {
    const engine = new InsightEngine()
    calibrate(engine)

    // Feed sustained high-yaw frames as if looking at a second monitor
    feedFrames(engine, { ...HIGH_YAW_FRAME, hasMultipleMonitors: true }, 300)

    expect(engine.getLiveMetrics().tYaw).toBe(0)
  })

  it('T_yaw accumulates on a single-monitor setup after the grace period', () => {
    const engine = new InsightEngine()
    calibrate(engine)

    // Feed past the T_YAW_IGNORE_SEC grace window
    const gracePlusFrames = Math.round((T_YAW_IGNORE_SEC + 5) * 1000 / 67)
    feedFrames(engine, { ...HIGH_YAW_FRAME, hasMultipleMonitors: false }, gracePlusFrames)

    expect(engine.getLiveMetrics().tYaw).toBeGreaterThan(0)
  })

  it('T_yaw that built up on single-monitor decays when multi-monitor is detected', () => {
    const engine = new InsightEngine()
    calibrate(engine)

    // Build up T_yaw on single monitor
    const gracePlusFrames = Math.round((T_YAW_IGNORE_SEC + 10) * 1000 / 67)
    feedFrames(engine, { ...HIGH_YAW_FRAME, hasMultipleMonitors: false }, gracePlusFrames)
    const tYawBefore = engine.getLiveMetrics().tYaw
    expect(tYawBefore).toBeGreaterThan(0)

    // Plug in a second monitor — T_yaw should decay to 0
    feedFrames(engine, { ...HIGH_YAW_FRAME, hasMultipleMonitors: true }, 300)

    expect(engine.getLiveMetrics().tYaw).toBe(0)
  })

  it('high yaw causes no engagement penalty on multi-monitor', () => {
    const engine = new InsightEngine()
    calibrate(engine)

    // Long sustained yaw on multi-monitor — score should stay near 100
    // Include blinks to prevent eyeComfort decay from confounding the yaw signal
    feedFrames(engine, { ...HIGH_YAW_FRAME, blinkJustCompleted: true, hasMultipleMonitors: true }, 1000)

    // Score must not have dropped from yaw alone (eyeComfort may drift slightly)
    expect(engine.score).toBeGreaterThan(85)
  })

  it('same high yaw causes engagement penalty on single-monitor', () => {
    const engine = new InsightEngine()
    calibrate(engine)

    // Long sustained yaw on single-monitor — score should drop
    feedFrames(engine, { ...HIGH_YAW_FRAME, hasMultipleMonitors: false }, 1000)

    expect(engine.score).toBeLessThan(95)
  })

  it('chinDown does not accumulate T_off when yaw is above HEAD_YAW_MAX_FOR_CHIN_DOWN', () => {
    // This is enforced in the tracker (chinDown=false at high yaw), but we can
    // verify the engine respects it: passing chinDown=false with high yaw should
    // not accumulate T_off regardless of pitch.
    const engine = new InsightEngine()
    calibrate(engine)

    feedFrames(engine, {
      ...GOOD_FRAME,
      chinDown: false,           // tracker would set this false at high yaw
      pitchSmoothed: 0.28,       // pitch is high but chinDown gate is closed
      yawSmoothed: 0.5,
      hasMultipleMonitors: false,
    }, 300)

    expect(engine.getLiveMetrics().tOff).toBe(0)
  })

  it('hasMultipleMonitors flag is respected frame-by-frame (no stale state)', () => {
    const engine = new InsightEngine()
    calibrate(engine)

    // Alternate between single and multi monitor
    for (let i = 0; i < 10; i++) {
      feedFrames(engine, { ...HIGH_YAW_FRAME, hasMultipleMonitors: false }, 30)
      feedFrames(engine, { ...HIGH_YAW_FRAME, hasMultipleMonitors: true }, 30)
    }

    // After ending on multi-monitor, T_yaw should be 0
    expect(engine.getLiveMetrics().tYaw).toBe(0)
  })
})
