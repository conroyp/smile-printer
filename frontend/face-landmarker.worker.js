importScripts("/vendor/mediapipe/vision_bundle.js");

const { FaceLandmarker, FilesetResolver } = Vision;

const WASM_PATH = "/vendor/mediapipe/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

let faceLandmarker = null;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function blendshapeScore(categories, name) {
  return categories.find((category) => category.categoryName === name)?.score ?? 0;
}

function summariseFace(result) {
  const landmarks = result.faceLandmarks?.[0];
  if (!landmarks?.length) return null;

  let minimumX = 1;
  let minimumY = 1;
  let maximumX = 0;
  let maximumY = 0;
  for (const landmark of landmarks) {
    minimumX = Math.min(minimumX, landmark.x);
    minimumY = Math.min(minimumY, landmark.y);
    maximumX = Math.max(maximumX, landmark.x);
    maximumY = Math.max(maximumY, landmark.y);
  }

  const categories = result.faceBlendshapes?.[0]?.categories || [];
  const smileScore =
    (blendshapeScore(categories, "mouthSmileLeft") +
      blendshapeScore(categories, "mouthSmileRight")) /
    2;

  return {
    box: {
      x: minimumX,
      y: minimumY,
      width: maximumX - minimumX,
      height: maximumY - minimumY,
    },
    smileScore,
  };
}

async function initialise(delegate) {
  const vision = await FilesetResolver.forVisionTasks(WASM_PATH);
  faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: "VIDEO",
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: false,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
}

self.addEventListener("message", async ({ data }) => {
  if (data.type === "INITIALISE") {
    try {
      await initialise(data.delegate || "GPU");
      self.postMessage({ type: "READY", delegate: data.delegate || "GPU" });
    } catch (error) {
      self.postMessage({ type: "INITIALISE_ERROR", message: errorMessage(error) });
    }
    return;
  }

  if (data.type !== "DETECT") return;

  const { bitmap, sessionId, timestamp } = data;
  if (!faceLandmarker) {
    bitmap.close();
    self.postMessage({
      type: "DETECT_ERROR",
      sessionId,
      message: "Face Landmarker has not initialized.",
    });
    return;
  }

  try {
    const width = bitmap.width;
    const height = bitmap.height;
    const result = faceLandmarker.detectForVideo(bitmap, timestamp);
    self.postMessage({
      type: "DETECT_RESULT",
      sessionId,
      timestamp,
      width,
      height,
      face: summariseFace(result),
    });
  } catch (error) {
    self.postMessage({
      type: "DETECT_ERROR",
      sessionId,
      message: errorMessage(error),
    });
  } finally {
    bitmap.close();
  }
});
