// tracker.js — MediaPipe Face Landmarker → smoothed features for the focus model.
//
// onUpdate(): ear, pitchSmoothed, rollRadSmoothed, yawSmoothed, chinDown,
// lipNormSmoothed, lookUpNormSmoothed, facePresent, geometryReliable,
// concentrationFrameTrusted, blinkJustCompleted, lastCompletedBlinkDurationMs

import {
  EAR_THRESHOLD,
  FEATURE_MA_WINDOW,
  HEAD_PITCH_CHIN_DOWN_ONSET,
  HEAD_PITCH_CHIN_DOWN_RELEASE,
  LOOK_UP_GAP_BASELINE,
  LOOK_UP_PITCH_DEADBAND,
  LOOK_UP_PITCH_GAIN,
  HEAD_ROLL_OFF_RAD,
  HEAD_YAW_MAX_FOR_CHIN_DOWN,
  MOTION_GATE_MEAN_SPEED,
  LEFT_EYE_6,
  RIGHT_EYE_6,
  earFromSixLandmarks,
  faceGeometryReliable,
} from './neurogaze-config.js'

const MEDIAPIPE_ESM = 'https://esm.sh/@mediapipe/tasks-vision@0.10.3'
const WASM_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm'
const FACE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'

const L_IRIS = 468
const R_IRIS = 473
const NOSE_TIP = 4
const L_EYE_OUT = 33
const R_EYE_OUT = 263
const CHIN = 152
const FOREHEAD = 10
const LIP_UPPER = 13
const LIP_LOWER = 14

const GAZE_BUFFER_MS = 1_500
const ANALYSIS_WINDOW_MS = 500

function normFaceHeight(lm) {
  return Math.abs(lm[CHIN].y - lm[FOREHEAD].y) || 0.001
}

function calcEARAverage(lm) {
  return (
    earFromSixLandmarks(lm, LEFT_EYE_6) + earFromSixLandmarks(lm, RIGHT_EYE_6)
  ) / 2
}

function calcHeadRollRad(lm) {
  const lx = lm[L_EYE_OUT].x
  const ly = lm[L_EYE_OUT].y
  const rx = lm[R_EYE_OUT].x
  const ry = lm[R_EYE_OUT].y
  const dx = rx - lx
  const dy = ry - ly
  if (Math.hypot(dx, dy) < 1e-9) return 0
  return Math.atan2(dy, dx)
}

function calcHeadPose(lm) {
  const fw = Math.abs(lm[R_EYE_OUT].x - lm[L_EYE_OUT].x) || 0.001
  const fh = normFaceHeight(lm)
  const eyeMidX = (lm[L_EYE_OUT].x + lm[R_EYE_OUT].x) / 2
  const yaw = (lm[NOSE_TIP].x - eyeMidX) / fw
  const midY = (lm[FOREHEAD].y + lm[CHIN].y) / 2
  const pitch = (lm[NOSE_TIP].y - midY) / fh
  const rollRad = calcHeadRollRad(lm)
  return { yaw, pitch, rollRad }
}

/**
 * Look-up / head-back: nose–eye vertical gap (in face-heights) shrinks when the user
 * tilts to look at the ceiling; pitch also goes negative in that pose.
 */
function calcLookUpNorm(lm, pitch) {
  const fh = normFaceHeight(lm)
  const eyeMidY = (lm[L_EYE_OUT].y + lm[R_EYE_OUT].y) / 2
  const gap = (lm[NOSE_TIP].y - eyeMidY) / fh
  const fromGap = Math.max(0, LOOK_UP_GAP_BASELINE - gap)
  const fromPitch = Math.max(0, LOOK_UP_PITCH_DEADBAND - pitch) * LOOK_UP_PITCH_GAIN
  return Math.min(0.4, fromGap + fromPitch)
}

function calcLipNorm(lm) {
  return Math.abs(lm[LIP_LOWER].y - lm[LIP_UPPER].y) / normFaceHeight(lm)
}

function meanBuffer(buf) {
  const n = buf.length
  if (n === 0) return null
  let s = 0
  for (let i = 0; i < n; i++) s += buf[i]
  return s / n
}

function pushRolling(buf, value, maxLen) {
  buf.push(value)
  while (buf.length > maxLen) buf.shift()
}

export class Tracker {
  #landmarker = null
  #stream = null
  #video = null
  #intervalId = null

  #gazeBuffer = []

  #eyeWasClosed = false
  #blinkCloseStart = null
  #blinkEndedThisFrame = false
  #lastCompletedBlinkDurationMs = 0

  #maEar = []
  #maLip = []
  #maPitch = []
  #maRoll = []
  #maYaw = []
  #maLookUp = []

  /** Pitch hysteresis: avoids rapid chin-down toggling from landmark noise. */
  #chinDownLatched = false

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

    const videoConstraints = { width: 640, height: 480 }
    if (deviceId) videoConstraints.deviceId = { exact: deviceId }
    else videoConstraints.facingMode = 'user'

    this.#stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints })

    this.#video = videoElement
    this.#video.srcObject = this.#stream
    this.#video.playsInline = true
    this.#video.muted = true
    await this.#video.play()

    this.#intervalId = setInterval(() => this.#processFrame(onUpdate), 67)
  }

  #trimGazeBuffer(now) {
    const tMin = now - GAZE_BUFFER_MS
    this.#gazeBuffer = this.#gazeBuffer.filter((g) => g.t >= tMin)
  }

  #windowMeanSpeed(now) {
    const tWin = now - ANALYSIS_WINDOW_MS
    const win = this.#gazeBuffer.filter((g) => g.t >= tWin)
    if (win.length < 3) return { meanSpeed: 0, n: win.length }

    let speedSum = 0
    let speedN = 0
    for (let i = 1; i < win.length; i++) {
      const a = win[i - 1]
      const b = win[i]
      const dt = (b.t - a.t) / 1000
      if (dt <= 0 || dt > 0.2) continue
      const d = Math.hypot(b.x - a.x, b.y - a.y)
      speedSum += d / dt
      speedN++
    }
    const meanSpeed = speedN > 0 ? speedSum / speedN : 0
    return { meanSpeed, n: win.length }
  }

  #recordBlinkState(ear, now) {
    this.#blinkEndedThisFrame = false
    const closed = ear < EAR_THRESHOLD

    if (closed && !this.#eyeWasClosed) {
      this.#blinkCloseStart = now
      this.#eyeWasClosed = true
    } else if (!closed && this.#eyeWasClosed) {
      if (this.#blinkCloseStart != null) {
        const durationMs = Math.min(800, Math.max(0, now - this.#blinkCloseStart))
        if (durationMs > 50) {
          this.#blinkEndedThisFrame = true
          this.#lastCompletedBlinkDurationMs = durationMs
        }
      }
      this.#blinkCloseStart = null
      this.#eyeWasClosed = false
    }
  }

  #updateFeatureBuffers(ear, lipNorm, pitch, rollRad, yaw, lookUpNorm, motionHeavy) {
    const bootstrap = this.#maEar.length === 0
    if (!motionHeavy || bootstrap) {
      pushRolling(this.#maEar, ear, FEATURE_MA_WINDOW)
      pushRolling(this.#maLip, lipNorm, FEATURE_MA_WINDOW)
      pushRolling(this.#maPitch, pitch, FEATURE_MA_WINDOW)
      pushRolling(this.#maRoll, rollRad, FEATURE_MA_WINDOW)
      pushRolling(this.#maYaw, yaw, FEATURE_MA_WINDOW)
      pushRolling(this.#maLookUp, lookUpNorm, FEATURE_MA_WINDOW)
    }
  }

  #resetBuffers() {
    this.#maEar = []
    this.#maLip = []
    this.#maPitch = []
    this.#maRoll = []
    this.#maYaw = []
    this.#maLookUp = []
    this.#chinDownLatched = false
  }

  #processFrame(onUpdate) {
    if (!this.#video || this.#video.readyState < 2) return

    const { faceLandmarks } = this.#landmarker.detectForVideo(this.#video, performance.now())
    const facePresent = faceLandmarks.length > 0

    const now = Date.now()

    let ear = 0.3
    let headPose = { pitch: 0, rollRad: 0, yaw: 0 }
    let lipNorm = 0
    let lookUpNorm = 0
    let motionHeavy = false
    let concentrationFrameTrusted = false
    let geometryReliable = false

    let blinkJustCompleted = false
    let lastCompletedBlinkDurationMs = 0

    if (facePresent) {
      const lm = faceLandmarks[0]
      ear = calcEARAverage(lm)
      headPose = calcHeadPose(lm)
      lipNorm = calcLipNorm(lm)
      lookUpNorm = calcLookUpNorm(lm, headPose.pitch)

      const hasIris = lm.length > L_IRIS
      const x = hasIris
        ? (lm[L_IRIS].x + lm[R_IRIS].x) / 2
        : (lm[L_EYE_OUT].x + lm[R_EYE_OUT].x) / 2
      const y = hasIris
        ? (lm[L_IRIS].y + lm[R_IRIS].y) / 2
        : (lm[L_EYE_OUT].y + lm[R_EYE_OUT].y) / 2

      const eyesOpen = ear >= EAR_THRESHOLD

      this.#recordBlinkState(ear, now)

      if (!eyesOpen) {
        this.#gazeBuffer = []
      } else {
        this.#gazeBuffer.push({ x, y, t: now })
        this.#trimGazeBuffer(now)

        const w = this.#windowMeanSpeed(now)
        motionHeavy = w.n >= 4 && w.meanSpeed > MOTION_GATE_MEAN_SPEED
      }

      const geometryOk = faceGeometryReliable(lm)
      geometryReliable = geometryOk
      concentrationFrameTrusted = geometryOk && !(eyesOpen && motionHeavy)

      this.#updateFeatureBuffers(
        ear,
        lipNorm,
        headPose.pitch,
        headPose.rollRad,
        headPose.yaw,
        lookUpNorm,
        motionHeavy,
      )
      blinkJustCompleted = this.#blinkEndedThisFrame
      lastCompletedBlinkDurationMs = this.#lastCompletedBlinkDurationMs
    } else {
      this.#resetBuffers()
      this.#gazeBuffer = []
    }

    const pitchSmoothed = meanBuffer(this.#maPitch) ?? headPose.pitch
    const rollRadSmoothed = meanBuffer(this.#maRoll) ?? headPose.rollRad
    const yawSmoothed = meanBuffer(this.#maYaw) ?? headPose.yaw
    if (facePresent) {
      if (this.#chinDownLatched) {
        if (pitchSmoothed < HEAD_PITCH_CHIN_DOWN_RELEASE) this.#chinDownLatched = false
      } else if (pitchSmoothed > HEAD_PITCH_CHIN_DOWN_ONSET) {
        this.#chinDownLatched = true
      }
    }
    const chinDown =
      facePresent &&
      this.#chinDownLatched &&
      Math.abs(yawSmoothed) < HEAD_YAW_MAX_FOR_CHIN_DOWN

    onUpdate({
      ear,
      pitchSmoothed,
      rollRadSmoothed,
      yawSmoothed,
      chinDown,
      lipNormSmoothed: meanBuffer(this.#maLip) ?? lipNorm,
      lookUpNormSmoothed: meanBuffer(this.#maLookUp) ?? lookUpNorm,
      facePresent,
      geometryReliable,
      concentrationFrameTrusted,
      blinkJustCompleted,
      lastCompletedBlinkDurationMs,
    })
  }

  stop() {
    clearInterval(this.#intervalId)
    this.#stream?.getTracks().forEach((t) => t.stop())
    this.#landmarker?.close()
  }
}
