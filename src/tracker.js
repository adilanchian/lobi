// tracker.js — Eye tracking engine powered by MediaPipe FaceLandmarker
// Runs in the renderer process, accesses the webcam
//
// Signals emitted ~15x/sec via onUpdate():
//   ear            — Eye Aspect Ratio (0.05–0.40, lower = more closed)
//   blinkRate      — blinks per minute, rolling 60s window
//   facePresent    — whether a face was detected this frame
//   headPose       — { yaw, pitch } derived from landmark geometry
//   gazeEngagement — 0.0–1.0 (peaks at purposeful reading movement; low when zoning out OR erratic)
//   gazeVariance   — raw combined x+y iris variance, used to distinguish zoning-out vs scattered

const MEDIAPIPE_ESM  = 'https://esm.sh/@mediapipe/tasks-vision@0.10.3'
const WASM_CDN       = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm'
const FACE_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'

// ─── Landmark Indices ─────────────────────────────────────────────────────────

const LEFT_EYE  = { top: 159, bottom: 145, outer: 33,  inner: 133 }
const RIGHT_EYE = { top: 386, bottom: 374, outer: 362, inner: 263 }

// Iris centres — part of the 478-point mesh, always included in face_landmarker.task
const L_IRIS = 468
const R_IRIS = 473

// Landmarks for head pose estimation
const NOSE_TIP  = 4
const L_EYE_OUT = 33
const R_EYE_OUT = 263
const CHIN      = 152
const FOREHEAD  = 10

const BLINK_THRESHOLD = 0.21
const BLINK_WINDOW_MS = 60_000
const GAZE_WINDOW_MS  = 6_000   // longer window so fixations don't dominate variance

// ─── Pure Math Helpers ────────────────────────────────────────────────────────

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)

function variance(arr) {
  if (arr.length < 2) return 0
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length
  return arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length
}

// ─── Signal Extractors ────────────────────────────────────────────────────────

function calcEAR(lm, eye) {
  return dist(lm[eye.top], lm[eye.bottom]) / dist(lm[eye.outer], lm[eye.inner])
}

// Head pose from landmark geometry — no transformation matrix needed
// yaw:   -0.5 (turned left) → 0 (straight) → +0.5 (turned right)
// pitch: negative (looking up) → 0 (straight) → positive (head drooping)
function calcHeadPose(lm) {
  const faceWidth  = Math.abs(lm[R_EYE_OUT].x - lm[L_EYE_OUT].x) || 0.001
  const faceHeight = Math.abs(lm[CHIN].y - lm[FOREHEAD].y)        || 0.001
  const eyeMidX    = (lm[L_EYE_OUT].x + lm[R_EYE_OUT].x) / 2

  const yaw   = (lm[NOSE_TIP].x - eyeMidX) / faceWidth
  const pitch = (lm[NOSE_TIP].y - lm[FOREHEAD].y) / faceHeight - 0.55

  return { yaw, pitch }
}

// ─── Tracker ──────────────────────────────────────────────────────────────────

export class Tracker {
  #landmarker      = null
  #stream          = null
  #video           = null
  #intervalId      = null
  #blinkTimestamps = []
  #gazeHistory     = []    // { x, y, t } — rolling GAZE_WINDOW_MS
  #eyeWasClosed    = false

  static async start(videoElement, onUpdate, deviceId = null) {
    const t = new Tracker()
    await t.#init(videoElement, onUpdate, deviceId)
    return t
  }

  async #init(videoElement, onUpdate, deviceId) {
    const { FaceLandmarker, FilesetResolver } = await import(MEDIAPIPE_ESM)
    const vision = await FilesetResolver.forVisionTasks(WASM_CDN)

    this.#landmarker = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: FACE_MODEL_URL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numFaces: 1,
    })

    // Explicit deviceId when provided; otherwise let the OS pick its default
    // camera (facingMode 'user' is a hint for devices that have front/rear cams).
    const videoConstraints = { width: 640, height: 480 }
    if (deviceId) videoConstraints.deviceId = { exact: deviceId }
    else          videoConstraints.facingMode = 'user'

    this.#stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints })

    this.#video             = videoElement
    this.#video.srcObject   = this.#stream
    this.#video.playsInline = true
    this.#video.muted       = true
    await this.#video.play()

    this.#intervalId = setInterval(() => this.#processFrame(onUpdate), 67)
  }

  #processFrame(onUpdate) {
    if (!this.#video || this.#video.readyState < 2) return

    const { faceLandmarks } = this.#landmarker.detectForVideo(this.#video, performance.now())
    const facePresent = faceLandmarks.length > 0

    let ear = 0.3, headPose = { yaw: 0, pitch: 0 }, gazeEngagement = 0.5, gazeVariance = 0

    if (facePresent) {
      const lm   = faceLandmarks[0]
      ear               = (calcEAR(lm, LEFT_EYE) + calcEAR(lm, RIGHT_EYE)) / 2
      headPose          = calcHeadPose(lm)
      const gaze        = this.#calcGazeEngagement(lm)
      gazeEngagement    = gaze.engagement
      gazeVariance      = gaze.variance
      this.#recordBlink(ear)
    }

    onUpdate({ ear, blinkRate: this.#blinkRate(), facePresent, headPose, gazeEngagement, gazeVariance })
  }

  // Track iris movement over 2 seconds and score engagement as a bell curve.
  //
  // For knowledge workers at a screen, purposeful eye movement (reading,
  // scanning documents, switching between windows) signals active engagement.
  // A completely still gaze is the "thousand-yard stare" — zoning out.
  // Very erratic movement signals distraction (looking at phone, around room).
  //
  // Bell curve shape (asymmetric):
  //   v ≈ 0       → prolonged blank stare    → ~0.75 (acceptable — could be deep thought)
  //   v ≈ 0.0008  → purposeful reading       → 1.0  (peak)
  //   v ≈ 0.002   → active multi-window scan → ~0.88 (great)
  //   v ≈ 0.004   → getting scattered        → ~0.55
  //   v ≈ 0.008+  → erratic / distracted     → ~0.35 (floor)
  #calcGazeEngagement(lm) {
    const hasIris = lm.length > L_IRIS
    const x = hasIris ? (lm[L_IRIS].x + lm[R_IRIS].x) / 2 : (lm[L_EYE_OUT].x + lm[R_EYE_OUT].x) / 2
    const y = hasIris ? (lm[L_IRIS].y + lm[R_IRIS].y) / 2 : (lm[L_EYE_OUT].y + lm[R_EYE_OUT].y) / 2

    const now = Date.now()
    this.#gazeHistory.push({ x, y, t: now })
    this.#gazeHistory = this.#gazeHistory.filter(g => now - g.t < GAZE_WINDOW_MS)

    if (this.#gazeHistory.length < 5) return { engagement: 0.5, variance: 0 }

    const v = variance(this.#gazeHistory.map(g => g.x)) +
              variance(this.#gazeHistory.map(g => g.y))

    // Asymmetric Gaussian: gentle left tail so fixations during deep reading
    // don't crater the score; tighter right tail still catches erratic scatter.
    const OPTIMAL    = 0.0008   // typical reading variance over 6s window
    const SIGMA_LOW  = 0.0008   // wide left — fixation is often deep focus, not zoning out
    const SIGMA_HIGH = 0.0030   // wide right — stay forgiving through active scanning
    const sigma      = v < OPTIMAL ? SIGMA_LOW : SIGMA_HIGH
    const engagement = Math.max(0.35, Math.exp(-Math.pow(v - OPTIMAL, 2) / (2 * sigma * sigma)))

    return { engagement, variance: v }
  }

  #recordBlink(ear) {
    if (ear < BLINK_THRESHOLD && !this.#eyeWasClosed) {
      this.#blinkTimestamps.push(Date.now())
      this.#eyeWasClosed = true
    } else if (ear >= BLINK_THRESHOLD) {
      this.#eyeWasClosed = false
    }
    const cutoff = Date.now() - BLINK_WINDOW_MS
    this.#blinkTimestamps = this.#blinkTimestamps.filter(t => t > cutoff)
  }

  #blinkRate() {
    return this.#blinkTimestamps.filter(t => t > Date.now() - 60_000).length
  }

  stop() {
    clearInterval(this.#intervalId)
    this.#stream?.getTracks().forEach(t => t.stop())
    this.#landmarker?.close()
  }
}
