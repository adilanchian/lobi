// insights.js — Brain readiness score engine
//
// Computes 4 independent sub-scores from tracking signals, then combines them
// into a single brain readiness score via weighted average.
//
//  eyeComfort  (30%) — blink rate + eye openness
//  focusLock   (25%) — gaze engagement (bell curve: peaks at purposeful reading movement)
//  posture     (20%) — head yaw + pitch
//  stamina     (25%) — session duration fatigue model
//
// Sub-scores are EMA-smoothed so they feel responsive but not jittery.
// Notifications fire at most once per 5 minutes, targeted at the worst signal.

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const WEIGHTS = {
  eyeComfort: 0.3,
  focusLock: 0.25,
  posture: 0.2,
  stamina: 0.25,
};

// Exponential moving average factor — lower = smoother but slower response
// 0.04 at 15fps ≈ ~2-second lag, which feels natural
const EMA = 0.04;

const NOTIFY_COOLDOWN_MS = 5 * 60 * 1000;
const FOCUS_MILESTONE_MS = 60 * 60 * 1000;

// Calibration completes when the tracker has produced stable signals, not on a timer.
// At ~15fps, 30 consecutive face-present frames ≈ 2s — enough for EMA to move off its
// initial `100` defaults toward real values and for the gaze history to accumulate.
const CALIBRATION_FRAMES = 30;

// ─── Sub-score Functions ──────────────────────────────────────────────────────
// Each returns 0–100 for the current tick based on its signal(s)

function scoreEyeComfort(ear, blinkRate, calibrating) {
  let s = 100;
  if (!calibrating) {
    // Screen workers naturally blink 3–8x/min in flow (vs 12–15 in conversation).
    // Only penalise genuinely abnormal rates — not the focused-screen-work baseline.
    if (blinkRate < 2)
      s -= 40; // nearly no blinking — dry eyes / zoning out
    else if (blinkRate < 5)
      s -= 15; // slightly low but normal for deep screen focus
    else if (blinkRate > 28)
      s -= 25; // very high — likely discomfort or eye strain
    else if (blinkRate > 22) s -= 10;
  }
  if (ear < 0.15) s -= 40;
  else if (ear < 0.21) s -= 20;
  return Math.max(0, s);
}

function scoreFocusLock(gazeEngagement) {
  return Math.round(gazeEngagement * 100);
}

function scorePosture({ yaw, pitch }) {
  let s = 100;
  const absYaw = Math.abs(yaw);
  if (absYaw > 0.4) s -= 50;
  else if (absYaw > 0.25) s -= 25;
  else if (absYaw > 0.15) s -= 10;
  if (pitch > 0.2) s -= 40;
  else if (pitch > 0.1) s -= 20;
  else if (pitch > 0.05) s -= 5;
  return Math.max(0, s);
}

function scoreStamina(sessionMs) {
  const m = sessionMs / 60_000;
  if (m < 25) return 100;
  if (m < 45) return Math.round(100 - (m - 25) * 1.5);
  if (m < 60) return Math.round(70 - (m - 45) * 2.0);
  return Math.max(10, Math.round(40 - (m - 60) * 0.5));
}

// ─── InsightEngine ────────────────────────────────────────────────────────────

export class InsightEngine {
  // Overall score and label — what the big ring shows
  score = 100;
  status = "Starting up...";
  recentInsights = [];

  // Sub-scores — each 0–100, EMA-smoothed, exposed directly for the UI
  subScores = { eyeComfort: 100, focusLock: 100, posture: 100, stamina: 100 };

  #lastNotifyTs   = 0;
  #goodFocusSince = Date.now();
  #sessionStart   = Date.now();
  #lastGazeVariance = 0;
  #scoreSum   = 0;
  #scoreCount = 0;
  #peakScore  = 0;
  #stableFrames = 0;   // consecutive frames with a detected face
  #calibrated   = false;

  get sessionMinutes() {
    return Math.floor((Date.now() - this.#sessionStart) / 60_000);
  }
  get isCalibrating() {
    return !this.#calibrated;
  }

  update({
    ear,
    blinkRate,
    facePresent,
    headPose = { yaw: 0, pitch: 0 },
    gazeEngagement = 0.5,
    gazeVariance = 0,
  }) {
    const now = Date.now();

    if (!facePresent) {
      this.#stableFrames = 0;           // dropout resets the calibration streak
      this.status = this.#calibrated ? "Away" : "Waiting for face...";
      return this.score;
    }

    // Lock in once we've seen enough clean consecutive frames
    if (!this.#calibrated) {
      this.#stableFrames++;
      if (this.#stableFrames >= CALIBRATION_FRAMES) this.#calibrated = true;
    }

    this.#lastGazeVariance = gazeVariance;

    // ── Raw sub-scores for this tick ──────────────────────────────────────────
    const raw = {
      eyeComfort: scoreEyeComfort(ear, blinkRate, this.isCalibrating),
      focusLock: scoreFocusLock(gazeEngagement),
      posture: scorePosture(headPose),
      stamina: scoreStamina(now - this.#sessionStart),
    };

    // ── EMA-smooth each sub-score ─────────────────────────────────────────────
    for (const key of Object.keys(this.subScores)) {
      this.subScores[key] = Math.round(
        this.subScores[key] * (1 - EMA) + raw[key] * EMA,
      );
    }

    // ── Overall = weighted average ────────────────────────────────────────────
    this.score = Math.round(
      this.subScores.eyeComfort * WEIGHTS.eyeComfort +
        this.subScores.focusLock * WEIGHTS.focusLock +
        this.subScores.posture * WEIGHTS.posture +
        this.subScores.stamina * WEIGHTS.stamina,
    );

    // ── Status label ──────────────────────────────────────────────────────────
    if (this.isCalibrating) this.status = "Calibrating...";
    else if (this.score >= 80) this.status = "Locked In";
    else if (this.score >= 65) this.status = "Focused";
    else if (this.score >= 50) this.status = "Drifting";
    else if (this.score >= 35) this.status = "Low Focus";
    else this.status = "Need a Break";

    if (this.score < 70) this.#goodFocusSince = now;

    if (!this.isCalibrating) {
      this.#scoreSum += this.score;
      this.#scoreCount++;
      this.#peakScore = Math.max(this.#peakScore, this.score);
    }

    this.#maybeFireInsight(now);
    return this.score;
  }

  getSessionData() {
    const now = Date.now();
    return {
      startTime:    this.#sessionStart,
      endTime:      now,
      durationMs:   now - this.#sessionStart,
      avgScore:     this.#scoreCount > 0 ? Math.round(this.#scoreSum / this.#scoreCount) : 0,
      peakScore:    this.#peakScore,
      insightCount: this.recentInsights.length,
    };
  }

  // Fires a notification targeted at the weakest signal
  #maybeFireInsight(now) {
    if (this.isCalibrating) return;
    if (now - this.#lastNotifyTs < NOTIFY_COOLDOWN_MS) return;

    const focusedFor = now - this.#goodFocusSince;
    const worstKey = Object.entries(this.subScores).sort(
      (a, b) => a[1] - b[1],
    )[0][0];

    let insight = null;

    if (this.score < 35) {
      insight = {
        title: "Time for a break 🧠",
        body: pick([
          "Step away, take a few deep breaths, and look at something far away. Two minutes is all it takes to recharge.",
          "Get up, refill your water, and walk around for 2 minutes. Your brain restores faster when your body moves.",
          "Close your eyes for 30 seconds, then take a short walk. Even micro-breaks reset your ability to concentrate.",
          "Stand up, stretch your arms overhead, and look out a window. A real pause — even a quick one — beats pushing through.",
          "Your brain has been working hard. Two minutes of doing nothing is surprisingly powerful — step away from the screen.",
        ]),
      };
    } else if (this.score < 55) {
      const targeted = {
        eyeComfort: {
          title: "Rest your eyes 👁",
          body: pick([
            "Look at something at least 20 feet away for 20 seconds. Letting your eye muscles fully relax prevents the slow drain that builds up over hours.",
            "Blink slowly 10 times, then focus on something in the distance. Staring at a screen suppresses blinking, which dries your eyes faster than you notice.",
            "Cover your eyes with your palms for 30 seconds — no light, no screen. It's one of the fastest ways to reduce eye fatigue.",
            "Look out a window and let your eyes adjust to natural distance. Your eye muscles have been locked at the same focal length for a while.",
            "Take 20 seconds to look far away and do a few slow blinks. A little deliberate rest goes a long way for recovery.",
          ]),
        },
        focusLock:
          this.#lastGazeVariance < 0.0004
            ? {
                title: "You're drifting 🌀",
                body: pick([
                  "Switch to a different task for a few minutes — novelty is one of the fastest ways to re-engage your brain.",
                  "Try jotting down 3 things you still need to finish today. Writing activates focus in a way that passive reading doesn't.",
                  "Splash cold water on your face or step outside for 60 seconds. A quick sensory change snaps your attention back.",
                  "Your brain might need a gear change. If you've been reading, try writing — or vice versa.",
                  "Stand up and do a few slow neck rolls. Sometimes your brain just needs your body to move first.",
                ]),
              }
            : {
                title: "Hard to focus? 👀",
                body: pick([
                  "Close everything except the one thing you're working on. Fewer inputs means your brain can lock in faster.",
                  "Write down the one thing you need to finish next, then close everything else. Clarity on the task cuts the mental noise.",
                  "Set a 10-minute timer and commit to just one tab, one task. The constraint actually helps.",
                  "Silence notifications and go full screen on your main task. Your brain can't truly multitask — make it easy to single-task.",
                  "Pick the single most important thing right now and put it in front of you. Decision fatigue is the enemy of focus.",
                ]),
              },
        posture: {
          title: "Time for a reset 🪑",
          body: pick([
            "Roll your shoulders back, unclench your jaw, and take a slow breath. Physical tension and mental fatigue feed each other.",
            "Sit up tall, put both feet flat on the floor, and take three deep breaths. Your posture signals your brain whether to be alert or tired.",
            "Take 30 seconds to stretch your neck slowly side to side. Tension there restricts blood flow and quietly drains your energy.",
            "Check in with your body — are you hunching, clenching your jaw, or holding your breath? Relax each one intentionally.",
            "Stand up for 60 seconds and shake out your hands. Sustained sitting compresses your spine and slowly reduces alertness.",
          ]),
        },
        stamina: {
          title: `${this.sessionMinutes} minutes in ⏱`,
          body: pick([
            "A short break now compounds — 5 minutes off the screen extends your next focus window significantly.",
            "The best time to take a break is before you feel like you need one. Step away now and come back stronger.",
            "Top performers schedule breaks — they don't wait to crash. A 5-minute walk now beats 30 minutes of diminished focus.",
            "Your brain runs in natural focus cycles. A short reset now keeps the next one just as sharp.",
            "Hydrate, stand up, and give your eyes a rest. These three things together are the fastest recovery combo.",
          ]),
        },
      };
      insight = targeted[worstKey];
    } else if (focusedFor > FOCUS_MILESTONE_MS && this.score >= 80) {
      insight = {
        title: "An hour in the zone 🔥",
        body: pick([
          "Seriously impressive. Take a real 10-minute break — move, hydrate, and you'll come back just as sharp.",
          "That's a full hour of deep work — most people can't sustain that. Protect the streak with a proper break before the next round.",
          "An hour of real focus is rare. Reward it with 10 minutes completely away from your screen — your brain has earned it.",
          "You've been in flow for an hour. A 10-minute break now resets your cognitive resources for another strong session.",
          "One hour down. A real break now — not just scrolling — keeps your performance high for the rest of the day.",
        ]),
      };
    }

    if (!insight) return;

    this.#lastNotifyTs = now;
    this.recentInsights.unshift({
      ...insight,
      time: new Date().toLocaleTimeString(),
    });
    if (this.recentInsights.length > 5) this.recentInsights.pop();

    window.lobi?.sendInsight(insight.title, insight.body);
    window.dispatchEvent(new CustomEvent("lobi-insight", { detail: insight }));
  }
}
