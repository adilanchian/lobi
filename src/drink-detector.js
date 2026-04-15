// drink-detector.js — Webcam-based water / drink detection
//
// Uses MediaPipe ObjectDetector (EfficientDet Lite0) to spot a bottle or cup
// in frame. A sustained detection counts as one drink, with a cooldown so sips
// don't double-count.
//
// Runs at the same framerate as FaceLandmarker (67ms). Object detection runs
// on CPU so it doesn't contend with FaceLandmarker's GPU context.
//
// Emits via onUpdate():
//   drinkCount — total drinks counted this session
//   justDrank  — true for the single frame when the counter was incremented
//   drinking   — true whenever a container is currently visible

const MEDIAPIPE_ESM = 'https://esm.sh/@mediapipe/tasks-vision@0.10.3'
const WASM_CDN      = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm'
const OBJECT_MODEL  = 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite'

// ─── Tuning ──────────────────────────────────────────────────────────────────

const DETECT_INTERVAL_MS = 67      // matches FaceLandmarker framerate
const DRINK_MIN_MS       = 1200    // must be visible this long to count
const DRINK_GAP_MS       = 700     // brief detection gaps don't reset the timer
const DRINK_COOLDOWN_MS  = 15_000  // min gap between counted drinks
const MIN_CONFIDENCE     = 0.20    // permissive — catches tilted/partially-visible containers

// COCO classes treated as drink containers
const DRINK_CLASSES = new Set(['bottle', 'cup', 'wine glass'])

// ─── DrinkDetector ───────────────────────────────────────────────────────────

export class DrinkDetector {
  #detector      = null
  #video         = null
  #intervalId    = null
  #drinkingSince = 0      // when the current streak started (0 = nothing detected)
  #lastSeenTs    = 0      // last frame a container was actually detected
  #counted       = false  // has this streak been counted already?
  #lastDrinkTs   = 0

  drinkCount = 0

  static async start(videoElement, onUpdate) {
    const d = new DrinkDetector()
    await d.#init(videoElement, onUpdate)
    return d
  }

  async #init(videoElement, onUpdate) {
    const { ObjectDetector, FilesetResolver } = await import(MEDIAPIPE_ESM)
    const vision = await FilesetResolver.forVisionTasks(WASM_CDN)

    this.#detector = await ObjectDetector.createFromOptions(vision, {
      baseOptions:    { modelAssetPath: OBJECT_MODEL, delegate: 'CPU' },
      runningMode:    'VIDEO',
      scoreThreshold: MIN_CONFIDENCE,
      maxResults:     10,
    })

    this.#video      = videoElement
    this.#intervalId = setInterval(() => this.#processFrame(onUpdate), DETECT_INTERVAL_MS)
  }

  #processFrame(onUpdate) {
    if (!this.#video || this.#video.readyState < 2) return

    const { detections } = this.#detector.detectForVideo(this.#video, performance.now())
    const drinkVisible   = detections.some(d =>
      DRINK_CLASSES.has(d.categories[0]?.categoryName))

    const now = Date.now()
    let justDrank = false

    if (drinkVisible) {
      if (!this.#drinkingSince) this.#drinkingSince = now
      this.#lastSeenTs = now

      if (!this.#counted
          && now - this.#drinkingSince > DRINK_MIN_MS
          && now - this.#lastDrinkTs   > DRINK_COOLDOWN_MS) {
        this.drinkCount++
        this.#counted     = true
        this.#lastDrinkTs = now
        justDrank         = true
      }
    } else if (this.#drinkingSince && now - this.#lastSeenTs > DRINK_GAP_MS) {
      this.#drinkingSince = 0
      this.#counted       = false
    }

    onUpdate({ drinkCount: this.drinkCount, drinking: drinkVisible, justDrank })
  }

  stop() {
    clearInterval(this.#intervalId)
    this.#detector?.close()
  }
}
