const WORKER_URL = "/face-landmarker.worker.js";
const INITIALISATION_TIMEOUT_MS = 30_000;

function abortError() {
  return new DOMException("Face detection was stopped.", "AbortError");
}

export class FaceDetectorClient {
  constructor(video, { intervalMs = 80, onResult, onError }) {
    this.video = video;
    this.intervalMs = intervalMs;
    this.onResult = onResult;
    this.onError = onError;
    this.worker = null;
    this.ready = false;
    this.active = false;
    this.destroyed = false;
    this.frameInFlight = false;
    this.sessionId = 0;
    this.lastDetectionAt = 0;
    this.consecutiveDetectionErrors = 0;
    this.videoFrameCallbackId = null;
    this.timerId = null;
    this.initialisationPromise = null;
    this.rejectInitialisation = null;

    this.handleWorkerMessage = this.handleWorkerMessage.bind(this);
    this.handleWorkerError = this.handleWorkerError.bind(this);
  }

  async initialise() {
    if (this.ready) return;
    if (this.destroyed) throw abortError();
    if (this.initialisationPromise) return this.initialisationPromise;

    const promise = this.initialiseWithFallback();
    this.initialisationPromise = promise;
    try {
      await promise;
    } finally {
      if (this.initialisationPromise === promise) this.initialisationPromise = null;
      this.rejectInitialisation = null;
    }
  }

  async initialiseWithFallback() {
    try {
      await this.spawnWorker("GPU");
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      console.warn("MediaPipe GPU delegate was unavailable; retrying with CPU.", error);
      await this.spawnWorker("CPU");
    }
  }

  spawnWorker(delegate) {
    this.terminateWorker();
    const worker = new Worker(WORKER_URL, { name: "face-landmarker" });
    this.worker = worker;

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        worker.removeEventListener("message", handleInitialMessage);
        worker.removeEventListener("error", handleInitialError);
        this.rejectInitialisation = null;
        callback(value);
      };
      const handleInitialMessage = ({ data }) => {
        if (data.type === "READY") {
          this.ready = true;
          worker.addEventListener("message", this.handleWorkerMessage);
          worker.addEventListener("error", this.handleWorkerError);
          finish(resolve);
        } else if (data.type === "INITIALISE_ERROR") {
          finish(reject, new Error(data.message || "MediaPipe could not initialize."));
        }
      };
      const handleInitialError = (event) => {
        event.preventDefault();
        finish(reject, new Error(event.message || "The face detection worker failed to load."));
      };
      const timeoutId = window.setTimeout(() => {
        finish(reject, new Error("Face detection took too long to initialize."));
      }, INITIALISATION_TIMEOUT_MS);

      this.rejectInitialisation = () => finish(reject, abortError());
      worker.addEventListener("message", handleInitialMessage);
      worker.addEventListener("error", handleInitialError);
      worker.postMessage({ type: "INITIALISE", delegate });
    }).catch((error) => {
      if (this.worker === worker) this.terminateWorker();
      throw error;
    });
  }

  start() {
    if (!this.ready || this.destroyed || this.active) return;
    this.active = true;
    this.frameInFlight = false;
    this.lastDetectionAt = 0;
    this.consecutiveDetectionErrors = 0;
    this.sessionId += 1;
    this.scheduleFrame();
  }

  stop() {
    this.active = false;
    this.frameInFlight = false;
    this.sessionId += 1;

    if (this.videoFrameCallbackId !== null) {
      this.video.cancelVideoFrameCallback?.(this.videoFrameCallbackId);
      this.videoFrameCallbackId = null;
    }
    clearTimeout(this.timerId);
    this.timerId = null;
  }

  destroy() {
    this.destroyed = true;
    this.stop();
    this.rejectInitialisation?.();
    this.terminateWorker();
  }

  terminateWorker() {
    if (this.worker) {
      this.worker.removeEventListener("message", this.handleWorkerMessage);
      this.worker.removeEventListener("error", this.handleWorkerError);
      this.worker.terminate();
    }
    this.worker = null;
    this.ready = false;
  }

  scheduleFrame() {
    if (!this.active) return;

    if (typeof this.video.requestVideoFrameCallback === "function") {
      this.videoFrameCallbackId = this.video.requestVideoFrameCallback((now) => {
        this.videoFrameCallbackId = null;
        void this.captureFrame(now);
      });
    } else {
      this.timerId = window.setTimeout(() => {
        this.timerId = null;
        void this.captureFrame(performance.now());
      }, this.intervalMs);
    }
  }

  async captureFrame(now) {
    const sessionId = this.sessionId;
    try {
      const shouldDetect =
        this.active &&
        this.ready &&
        !this.frameInFlight &&
        this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        now - this.lastDetectionAt >= this.intervalMs;

      if (!shouldDetect) return;

      this.frameInFlight = true;
      this.lastDetectionAt = now;
      const bitmap = await createImageBitmap(this.video);

      if (!this.active || sessionId !== this.sessionId || !this.worker) {
        bitmap.close();
        if (sessionId === this.sessionId) this.frameInFlight = false;
        return;
      }

      this.worker.postMessage(
        { type: "DETECT", bitmap, sessionId, timestamp: now },
        [bitmap],
      );
    } catch (error) {
      if (sessionId === this.sessionId) this.frameInFlight = false;
      if (this.active) console.warn("Could not copy a camera frame for detection.", error);
    } finally {
      this.scheduleFrame();
    }
  }

  handleWorkerMessage({ data }) {
    if (!["DETECT_RESULT", "DETECT_ERROR"].includes(data.type)) return;
    if (data.sessionId !== this.sessionId) return;

    this.frameInFlight = false;
    if (!this.active) return;

    if (data.type === "DETECT_ERROR") {
      this.consecutiveDetectionErrors += 1;
      if (this.consecutiveDetectionErrors < 3) {
        console.warn("MediaPipe could not process a camera frame.", data.message);
        return;
      }

      const error = new Error(data.message || "MediaPipe repeatedly failed to process camera frames.");
      this.stop();
      this.terminateWorker();
      this.onError(error);
      return;
    }

    this.consecutiveDetectionErrors = 0;
    this.onResult(data);
  }

  handleWorkerError(event) {
    event.preventDefault();
    const error = new Error(event.message || "The face detection worker stopped unexpectedly.");
    this.stop();
    this.terminateWorker();
    this.onError(error);
  }
}
