import assert from "node:assert/strict";
import { it } from "node:test";
import { FaceDetectorClient } from "../frontend/face-detector.js";

it("runs one frame at a time and terminates its worker without a blocking close call", async () => {
  const originalWorker = globalThis.Worker;
  const originalWindow = globalThis.window;
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  const originalHtmlMediaElement = globalThis.HTMLMediaElement;
  const workers = [];
  const results = [];

  class FakeWorker extends EventTarget {
    constructor(url, options) {
      super();
      this.url = url;
      this.options = options;
      this.terminated = false;
      workers.push(this);
    }

    postMessage(message) {
      if (message.type === "INITIALISE") {
        queueMicrotask(() => {
          this.dispatchEvent(new MessageEvent("message", { data: { type: "READY" } }));
        });
      } else if (message.type === "DETECT") {
        queueMicrotask(() => {
          this.dispatchEvent(
            new MessageEvent("message", {
              data: {
                type: "DETECT_RESULT",
                sessionId: message.sessionId,
                timestamp: message.timestamp,
                width: 1280,
                height: 720,
                face: null,
              },
            }),
          );
        });
      }
    }

    terminate() {
      this.terminated = true;
    }
  }

  const video = {
    readyState: 4,
    callback: null,
    canceledCallback: null,
    requestVideoFrameCallback(callback) {
      this.callback = callback;
      return 42;
    },
    cancelVideoFrameCallback(callbackId) {
      this.canceledCallback = callbackId;
    },
  };
  const bitmap = { close() {} };

  globalThis.Worker = FakeWorker;
  globalThis.window = globalThis;
  globalThis.HTMLMediaElement = { HAVE_CURRENT_DATA: 2 };
  globalThis.createImageBitmap = async () => bitmap;

  try {
    const detector = new FaceDetectorClient(video, {
      intervalMs: 80,
      onResult: (result) => results.push(result),
      onError: (error) => assert.fail(error),
    });

    await detector.initialise();
    detector.start();
    video.callback(100);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(results.length, 1);
    assert.equal(workers.length, 1);
    assert.equal(workers[0].options.type, undefined);

    detector.destroy();
    assert.equal(workers[0].terminated, true);
    assert.equal(video.canceledCallback, 42);
  } finally {
    globalThis.Worker = originalWorker;
    globalThis.window = originalWindow;
    globalThis.createImageBitmap = originalCreateImageBitmap;
    globalThis.HTMLMediaElement = originalHtmlMediaElement;
  }
});
