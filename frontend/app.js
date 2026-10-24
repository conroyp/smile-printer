import { FaceDetectorClient } from "./face-detector.js";
import { renderReceipt } from "./receipt.js";

const CONFIG = {
  steadyHoldMs: 1500,
  smileHoldMs: 1000,
  smileThreshold: 0.65,
  detectEveryMs: 80,
  capturePadding: 0.1,
  unitPrice: 430,
  currency: "eur",
  discountPercentage: 10,
  minQuantity: 1,
  maxQuantity: 20,
};

const EDITABLE_PHASES = new Set(["idle", "payment_failed"]);
const DISABLED_PAY_PHASES = new Set(["paying", "printing", "complete"]);
const PROCESSING_PHASES = new Set(["paying", "printing"]);
const PAY_LABELS = {
  payment_unknown: "Check payment",
  print_failed: "Retry receipt",
  complete: "Paid & printed",
};
const PRINTER_ERROR_MESSAGES = {
  reason_busy: "The printer is already busy.",
  reason_paperjam: "The printer has a paper jam.",
  reason_out_of_paper: "The printer is out of paper.",
  reason_cover_open: "The printer cover is open.",
  reason_absent: "The selected terminal has no printer.",
  reason_low_battery: "The printer battery is too low.",
  reason_generic_failure: "The printer could not complete the receipt.",
  printer_not_supported: "The selected terminal has no compatible printer.",
  reason_unavailable: "The printer did not respond in time.",
  terminal_reader_offline: "The selected printer is offline.",
};

function byId(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required element #${id}`);
  return element;
}

const elements = {
  cameraStage: byId("cameraStage"),
  video: byId("video"),
  overlay: byId("overlay"),
  cameraMessage: byId("cameraMessage"),
  messageIcon: byId("messageIcon"),
  statusTitle: byId("statusTitle"),
  statusDetail: byId("statusDetail"),
  cameraError: byId("cameraError"),
  cameraErrorText: byId("cameraErrorText"),
  cameraRetry: byId("cameraRetry"),
  livePill: byId("livePill"),
  faceStep: byId("faceStep"),
  smileStep: byId("smileStep"),
  savingStep: byId("savingStep"),
  steadyProgress: byId("steadyProgress"),
  smileProgress: byId("smileProgress"),
  quantity: byId("quantity"),
  minusButton: byId("minusButton"),
  plusButton: byId("plusButton"),
  unitPrice: byId("unitPrice"),
  subtotal: byId("subtotal"),
  discount: byId("discount"),
  discountRow: byId("discountRow"),
  total: byId("total"),
  printerSelect: byId("printerSelect"),
  refreshPrinters: byId("refreshPrinters"),
  printerError: byId("printerError"),
  payButton: byId("payButton"),
  payLabel: byId("payLabel"),
  payAmount: byId("payAmount"),
  paymentProgress: byId("paymentProgress"),
  paymentProgressTitle: byId("paymentProgressTitle"),
  paymentProgressDetail: byId("paymentProgressDetail"),
  transactionStatus: byId("transactionStatus"),
  transactionIcon: byId("transactionIcon"),
  transactionTitle: byId("transactionTitle"),
  transactionDetail: byId("transactionDetail"),
  nextOrderButton: byId("nextOrderButton"),
  orderNumber: byId("orderNumber"),
  receiptPreview: byId("receiptPreview"),
  receiptCanvas: byId("receiptCanvas"),
};

const overlayContext = elements.overlay.getContext("2d");

const state = {
  configReady: false,
  quantity: 2,
  discountUnlocked: false,
  phase: "idle",
  capturedFace: null,
  capturedBox: null,
  paymentIntentId: null,
  transactionKey: null,
  resetTimer: null,
  orderNumber: makeOrderNumber(),
};

let cameraStream = null;
let faceDetector = null;
let cameraInitialisation = null;
let cameraRequestId = 0;
let steadySince = null;
let steadyAnchor = null;
let smilingSince = null;

function makeOrderNumber() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function money(amount) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: CONFIG.currency.toUpperCase(),
    }).format(amount / 100);
  } catch {
    return `${CONFIG.currency.toUpperCase()} ${(amount / 100).toFixed(2)}`;
  }
}

function totals() {
  const subtotal = CONFIG.unitPrice * state.quantity;
  const discount = state.discountUnlocked
    ? Math.round((subtotal * CONFIG.discountPercentage) / 100)
    : 0;

  return { subtotal, discount, total: subtotal - discount };
}

function orderIsEditable() {
  return EDITABLE_PHASES.has(state.phase);
}

function renderCurrentReceipt() {
  renderReceipt(
    elements.receiptCanvas,
    {
      ...totals(),
      capturedFace: state.capturedFace,
      discountPercentage: CONFIG.discountPercentage,
      discountUnlocked: state.discountUnlocked,
      orderNumber: state.orderNumber,
      quantity: state.quantity,
    },
    money,
  );
}

function setCameraMessage(kind, title, detail, icon) {
  elements.cameraMessage.dataset.kind = kind;
  elements.statusTitle.textContent = title;
  elements.statusDetail.textContent = detail;
  elements.messageIcon.textContent = icon;
}

function setProgress(stage, steadyPercent = 0, smilePercent = 0) {
  const stages = [elements.faceStep, elements.smileStep, elements.savingStep];
  stages.forEach((element) => element.classList.remove("active", "done"));

  if (stage === "face") {
    elements.faceStep.classList.add("active");
  } else if (stage === "smile") {
    elements.faceStep.classList.add("done");
    elements.smileStep.classList.add("active");
  } else if (stage === "saving") {
    elements.faceStep.classList.add("done");
    elements.smileStep.classList.add("done");
    elements.savingStep.classList.add("active");
  } else if (stage === "done") {
    stages.forEach((element) => element.classList.add("done"));
  }

  elements.steadyProgress.style.width = `${clamp(steadyPercent, 0, 100)}%`;
  elements.smileProgress.style.width = `${clamp(smilePercent, 0, 100)}%`;
}

function updateOrder() {
  const amounts = totals();
  const locked = !orderIsEditable();

  elements.quantity.textContent = state.quantity;
  elements.orderNumber.textContent = `#${state.orderNumber}`;
  elements.unitPrice.textContent = `${money(CONFIG.unitPrice)} each`;
  elements.subtotal.textContent = money(amounts.subtotal);
  elements.discount.textContent = state.discountUnlocked ? `−${money(amounts.discount)}` : "";
  elements.discountRow.classList.toggle("unlocked", state.discountUnlocked);
  elements.total.textContent = money(amounts.total);
  elements.payAmount.textContent = money(amounts.total);
  elements.minusButton.disabled = locked || state.quantity <= CONFIG.minQuantity;
  elements.plusButton.disabled = locked || state.quantity >= CONFIG.maxQuantity;
  elements.printerSelect.disabled = locked || !elements.printerSelect.value;
  elements.refreshPrinters.disabled = locked;

  elements.payLabel.textContent = PAY_LABELS[state.phase] || "Pay";
  elements.payAmount.hidden = Boolean(PAY_LABELS[state.phase]);
  elements.payButton.disabled =
    !state.configReady || DISABLED_PAY_PHASES.has(state.phase) || !elements.printerSelect.value;

  const processing = PROCESSING_PHASES.has(state.phase);
  elements.payButton.hidden = processing;
  elements.paymentProgress.hidden = !processing;
}

function setPaymentProgress(title, detail) {
  clearTransactionStatus();
  elements.paymentProgressTitle.textContent = title;
  elements.paymentProgressDetail.textContent = detail;
}

function setTransactionStatus(kind, title, detail) {
  elements.transactionStatus.hidden = false;
  elements.transactionStatus.dataset.kind = kind;
  elements.transactionTitle.textContent = title;
  elements.transactionDetail.textContent = detail;
  elements.transactionIcon.textContent = kind === "success" ? "✓" : "!";
}

function clearTransactionStatus() {
  elements.transactionStatus.hidden = true;
  elements.transactionTitle.textContent = "";
  elements.transactionDetail.textContent = "";
  elements.transactionIcon.textContent = "";
}

function resizeOverlay() {
  const dpr = window.devicePixelRatio || 1;
  const { width, height } = elements.cameraStage.getBoundingClientRect();
  elements.overlay.width = Math.round(width * dpr);
  elements.overlay.height = Math.round(height * dpr);
  overlayContext.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (state.capturedBox) {
    drawFaceBox(state.capturedBox, "green");
  }
}

function expandFaceBox(box) {
  const extraX = box.width * 0.2;
  const extraTop = box.height * 0.28;
  const extraBottom = box.height * 0.1;

  return {
    x: box.x - extraX,
    y: box.y - extraTop,
    width: box.width + extraX * 2,
    height: box.height + extraTop + extraBottom,
  };
}

function videoBoxToStage(box) {
  const videoRatio = elements.video.videoWidth / elements.video.videoHeight;
  const stageRatio = elements.cameraStage.clientWidth / elements.cameraStage.clientHeight;
  let renderedWidth;
  let renderedHeight;
  let offsetX;
  let offsetY;

  if (videoRatio > stageRatio) {
    renderedHeight = elements.cameraStage.clientHeight;
    renderedWidth = renderedHeight * videoRatio;
    offsetX = (elements.cameraStage.clientWidth - renderedWidth) / 2;
    offsetY = 0;
  } else {
    renderedWidth = elements.cameraStage.clientWidth;
    renderedHeight = renderedWidth / videoRatio;
    offsetX = 0;
    offsetY = (elements.cameraStage.clientHeight - renderedHeight) / 2;
  }

  const scaleX = renderedWidth / elements.video.videoWidth;
  const scaleY = renderedHeight / elements.video.videoHeight;
  const unmirroredX = offsetX + box.x * scaleX;
  const width = box.width * scaleX;

  return {
    x: elements.cameraStage.clientWidth - unmirroredX - width,
    y: offsetY + box.y * scaleY,
    width,
    height: box.height * scaleY,
  };
}

function drawFaceBox(box, colour) {
  const width = elements.cameraStage.clientWidth;
  const height = elements.cameraStage.clientHeight;
  overlayContext.clearRect(0, 0, width, height);
  if (!box) return;

  const transformed = videoBoxToStage(expandFaceBox(box));
  const palette = { red: "#ff6258", orange: "#f4a43c", green: "#55e27d" };
  const stroke = palette[colour] || palette.red;
  const radius = Math.min(28, transformed.width * 0.1);
  const corner = Math.min(40, transformed.width * 0.18);

  overlayContext.save();
  overlayContext.lineWidth = 2;
  overlayContext.strokeStyle = stroke;
  overlayContext.shadowBlur = colour === "green" ? 18 : 9;
  overlayContext.shadowColor = stroke;
  overlayContext.globalAlpha = 0.82;
  overlayContext.beginPath();
  overlayContext.roundRect(
    transformed.x,
    transformed.y,
    transformed.width,
    transformed.height,
    radius,
  );
  overlayContext.stroke();

  overlayContext.globalAlpha = 1;
  overlayContext.lineWidth = 5;
  overlayContext.lineCap = "round";
  const { x, y, width: w, height: h } = transformed;
  const corners = [
    [[x, y + corner], [x, y + radius], [x + radius, y], [x + corner, y]],
    [[x + w - corner, y], [x + w - radius, y], [x + w, y + radius], [x + w, y + corner]],
    [[x + w, y + h - corner], [x + w, y + h - radius], [x + w - radius, y + h], [x + w - corner, y + h]],
    [[x + corner, y + h], [x + radius, y + h], [x, y + h - radius], [x, y + h - corner]],
  ];

  corners.forEach((points) => {
    overlayContext.beginPath();
    overlayContext.moveTo(points[0][0], points[0][1]);
    points.slice(1).forEach(([pointX, pointY]) => overlayContext.lineTo(pointX, pointY));
    overlayContext.stroke();
  });
  overlayContext.restore();
}

function isFaceStill(box) {
  if (!steadyAnchor) return false;

  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  const anchorX = steadyAnchor.x + steadyAnchor.width / 2;
  const anchorY = steadyAnchor.y + steadyAnchor.height / 2;
  const movement = Math.hypot(centerX - anchorX, centerY - anchorY) / Math.max(box.width, box.height);
  const scaleChange = Math.abs(box.width * box.height / (steadyAnchor.width * steadyAnchor.height) - 1);

  return movement < 0.08 && scaleChange < 0.16;
}

function resetFaceTracking() {
  steadySince = null;
  steadyAnchor = null;
  smilingSince = null;
}

function updateFaceState(box, smileScore, now) {
  if (state.discountUnlocked) {
    drawFaceBox(state.capturedBox || box, "green");
    return;
  }

  if (!orderIsEditable()) {
    drawFaceBox(box, "orange");
    return;
  }

  if (!steadyAnchor || !isFaceStill(box)) {
    steadyAnchor = { ...box };
    steadySince = now;
    smilingSince = null;
  }

  const steadyElapsed = now - steadySince;
  const steadyPercent = (steadyElapsed / CONFIG.steadyHoldMs) * 100;

  if (steadyElapsed < CONFIG.steadyHoldMs) {
    drawFaceBox(box, "red");
    setCameraMessage("", "Hold still!", "Keep your face steady for a moment", "⌁");
    setProgress("face", steadyPercent, 0);
    return;
  }

  const smiling = smileScore >= CONFIG.smileThreshold;
  if (!smiling) {
    smilingSince = null;
    drawFaceBox(box, "orange");
    setCameraMessage("orange", "Now smile!", "Hold your smile for one second", "☺");
    setProgress("smile", 100, 0);
    return;
  }

  if (smilingSince === null) smilingSince = now;
  const smileElapsed = now - smilingSince;
  const smilePercent = (smileElapsed / CONFIG.smileHoldMs) * 100;

  if (smileElapsed < CONFIG.smileHoldMs) {
    drawFaceBox(box, "orange");
    setCameraMessage("orange", "Keep smiling…", "You’re nearly there", "☺");
    setProgress("saving", 100, smilePercent);
    return;
  }

  unlockDiscount(box);
}

function unlockDiscount(box) {
  if (state.phase === "payment_failed") {
    state.phase = "idle";
    state.transactionKey = null;
    clearTransactionStatus();
  }
  state.discountUnlocked = true;
  state.capturedBox = { ...box };
  state.capturedFace = captureFace(box);
  elements.cameraStage.animate(
    [{ filter: "brightness(1)" }, { filter: "brightness(1.65)" }, { filter: "brightness(1)" }],
    { duration: 240, easing: "ease-out" },
  );
  elements.receiptPreview.open = true;
  drawFaceBox(box, "green");
  setCameraMessage(
    "green",
    `${CONFIG.discountPercentage}% unlocked!`,
    "That smile just made your coffee cheaper",
    "✓",
  );
  setProgress("done", 100, 100);
  renderCurrentReceipt();
  updateOrder();
}

function captureFace(box) {
  const expanded = expandFaceBox(box);
  const paddingX = expanded.width * CONFIG.capturePadding;
  const paddingY = expanded.height * CONFIG.capturePadding;
  const sourceX = clamp(expanded.x - paddingX, 0, elements.video.videoWidth);
  const sourceY = clamp(expanded.y - paddingY, 0, elements.video.videoHeight);
  const endX = clamp(expanded.x + expanded.width + paddingX, 0, elements.video.videoWidth);
  const endY = clamp(expanded.y + expanded.height + paddingY, 0, elements.video.videoHeight);
  const sourceWidth = Math.max(1, endX - sourceX);
  const sourceHeight = Math.max(1, endY - sourceY);
  const canvas = document.createElement("canvas");

  canvas.width = Math.round(sourceWidth);
  canvas.height = Math.round(sourceHeight);
  const context = canvas.getContext("2d");
  context.translate(canvas.width, 0);
  context.scale(-1, 1);
  context.drawImage(
    elements.video,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    canvas.width,
    canvas.height,
  );

  return canvas;
}

function handleDetectionResult({ face, width, height, timestamp }) {
  if (!face) {
    if (!state.discountUnlocked && orderIsEditable()) {
      resetFaceTracking();
      drawFaceBox(null);
      setCameraMessage("", "Step into view", "Position your face in front of the camera", "⌁");
      setProgress("face", 0, 0);
    }
    return;
  }

  const box = {
    x: face.box.x * width,
    y: face.box.y * height,
    width: face.box.width * width,
    height: face.box.height * height,
  };
  updateFaceState(box, face.smileScore, timestamp);
}

function showCameraError(error) {
  console.error("Camera or face detection failed", error);
  elements.cameraErrorText.textContent = cameraErrorMessage(error);
  elements.cameraError.hidden = false;
  elements.cameraRetry.hidden = false;
  elements.cameraMessage.hidden = true;
  elements.livePill.hidden = true;
}

function handleDetectionError(error) {
  stopCamera();
  showCameraError(error);
}

function createFaceDetector() {
  return new FaceDetectorClient(elements.video, {
    intervalMs: CONFIG.detectEveryMs,
    onResult: handleDetectionResult,
    onError: handleDetectionError,
  });
}

function stopCamera({ clearOverlay = true } = {}) {
  faceDetector?.stop();
  cameraStream?.getTracks().forEach((track) => track.stop());
  cameraStream = null;
  elements.video.pause();
  elements.video.srcObject = null;
  elements.livePill.hidden = true;
  resetFaceTracking();
  if (clearOverlay) drawFaceBox(null);
}

function destroyVision() {
  cameraRequestId += 1;
  cameraInitialisation = null;
  stopCamera();
  faceDetector?.destroy();
  faceDetector = null;
}

async function startCamera() {
  const requestId = ++cameraRequestId;
  stopCamera();
  elements.cameraError.hidden = true;
  elements.cameraRetry.hidden = true;
  elements.cameraMessage.hidden = false;
  elements.livePill.hidden = true;
  setCameraMessage("", "Starting camera…", "Your image is processed locally", "⌁");

  try {
    faceDetector ||= createFaceDetector();
    await faceDetector.initialise();
    if (requestId !== cameraRequestId) return;

    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "user",
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });
    if (requestId !== cameraRequestId) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    cameraStream = stream;
    elements.video.srcObject = cameraStream;
    await elements.video.play();
    if (requestId !== cameraRequestId) return;

    elements.livePill.hidden = false;
    resetFaceTracking();
    setCameraMessage("", "Step into view", "Position your face in front of the camera", "⌁");
    faceDetector.start();
  } catch (error) {
    if (error?.name === "AbortError" || requestId !== cameraRequestId) return;
    stopCamera();
    showCameraError(error);
  }
}

async function initialiseCamera() {
  if (cameraInitialisation) return cameraInitialisation;

  const promise = startCamera();
  cameraInitialisation = promise;
  try {
    await promise;
  } finally {
    if (cameraInitialisation === promise) cameraInitialisation = null;
  }
}

function cameraErrorMessage(error) {
  if (!window.isSecureContext) {
    return "Camera access needs HTTPS (or localhost). You can still take payment without the discount.";
  }
  if (error?.name === "NotAllowedError") {
    return "Camera permission was declined. Allow it in your browser settings, then try again.";
  }
  if (error?.name === "NotFoundError") {
    return "No camera was found. You can still take payment without the discount.";
  }
  if (/face detection|mediapipe|landmarker/i.test(error?.message || "")) {
    return "Face detection could not start. Try again, or continue without the discount.";
  }
  return "Check that the camera is available and try again. Payment still works without the discount.";
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(body.message || "Something went wrong. Please try again.");
    error.code = body.code;
    error.status = response.status;
    throw error;
  }

  return body;
}

async function loadConfiguration() {
  try {
    const config = await api("/api/config");
    CONFIG.unitPrice = config.unitPrice;
    CONFIG.currency = config.currency;
    CONFIG.discountPercentage = config.discountPercentage;
    state.configReady = true;
    renderCurrentReceipt();
    updateOrder();
  } catch (error) {
    console.error("Could not load shop configuration", error);
    setTransactionStatus("error", "Checkout unavailable", "Reload the page to try again.");
    updateOrder();
  }
}

async function loadPrinters() {
  if (!orderIsEditable()) return;
  elements.refreshPrinters.classList.add("loading");
  elements.refreshPrinters.disabled = true;
  elements.printerSelect.disabled = true;
  elements.printerSelect.replaceChildren(new Option("Looking for printers…", ""));
  elements.printerError.hidden = true;

  try {
    const { printers } = await api("/api/printers");
    elements.printerSelect.replaceChildren();

    if (printers.length === 0) {
      elements.printerSelect.append(new Option("No printers available", ""));
      elements.printerError.textContent = "No compatible printers were found on Stripe.";
      elements.printerError.hidden = false;
    } else {
      printers.forEach((printer) => {
        const details = [printer.label || "V660p", printer.serialNumber].filter(Boolean).join(" · ");
        elements.printerSelect.append(new Option(details, printer.id));
      });
    }
  } catch (error) {
    elements.printerSelect.replaceChildren(new Option("Printers unavailable", ""));
    elements.printerError.textContent =
      error.code === "stripe_not_configured"
        ? "Add a Stripe test key to the server to find compatible printers."
        : "Couldn’t load printers from Stripe. Try refreshing.";
    elements.printerError.hidden = false;
  } finally {
    elements.refreshPrinters.classList.remove("loading");
    elements.refreshPrinters.disabled = !orderIsEditable();
    updateOrder();
  }
}

function changeQuantity(change) {
  if (!orderIsEditable()) return;
  state.quantity = clamp(state.quantity + change, CONFIG.minQuantity, CONFIG.maxQuantity);
  state.transactionKey = null;
  state.phase = "idle";
  clearTransactionStatus();
  renderCurrentReceipt();
  updateOrder();
}

async function handlePay() {
  if (state.phase === "print_failed") {
    await printReceipt();
    return;
  }
  if (DISABLED_PAY_PHASES.has(state.phase)) return;

  const printerId = elements.printerSelect.value;
  if (!printerId) return;

  state.phase = "paying";
  state.transactionKey ||= crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  resetFaceTracking();
  if (!state.discountUnlocked) {
    setCameraMessage("orange", "Payment in progress", "Follow the instructions on the terminal", "→");
  }
  setPaymentProgress("Waiting for payment", "Follow the instructions on the terminal.");
  updateOrder();

  try {
    const payment = await api("/api/payments", {
      method: "POST",
      headers: { "Idempotency-Key": state.transactionKey },
      body: JSON.stringify({
        printerId,
        quantity: state.quantity,
        discountApplied: state.discountUnlocked,
      }),
    });
    state.paymentIntentId = payment.paymentIntentId;
    await printReceipt();
  } catch (error) {
    const paymentUnknown = error.code === "payment_timeout" || !error.status;
    state.phase = paymentUnknown ? "payment_unknown" : "payment_failed";
    resetFaceTracking();
    updateOrder();
    setTransactionStatus(
      "error",
      paymentUnknown ? "Payment result unknown" : "Payment wasn’t completed",
      paymentUnknown ? `${error.message} Check the original payment before trying again.` : error.message,
    );
  }
}

async function printReceipt() {
  if (!state.paymentIntentId || !elements.printerSelect.value) return;
  state.phase = "printing";
  setPaymentProgress("Payment complete", "Sending the receipt to the printer…");
  updateOrder();

  try {
    const result = await api("/api/receipts/print", {
      method: "POST",
      body: JSON.stringify({
        printerId: elements.printerSelect.value,
        paymentIntentId: state.paymentIntentId,
        imageDataUrl: elements.receiptCanvas.toDataURL("image/png"),
      }),
    });

    if (result.status !== "succeeded") {
      throw new Error(result.message || "The printer could not finish the receipt.");
    }

    state.phase = "complete";
    updateOrder();
    setTransactionStatus(
      "success",
      "Paid and printed",
      "This order is complete. Resetting for the next customer…",
    );
    elements.nextOrderButton.hidden = false;
    clearTimeout(state.resetTimer);
    state.resetTimer = window.setTimeout(resetOrder, 3500);
  } catch (error) {
    state.phase = "print_failed";
    updateOrder();
    setTransactionStatus(
      "error",
      "Paid, but the receipt didn’t print",
      `${printerErrorMessage(error.code, error.message)} You won’t be charged again.`,
    );
    elements.nextOrderButton.hidden = false;
  }
}

function printerErrorMessage(code, fallback) {
  return PRINTER_ERROR_MESSAGES[code] || fallback || "The printer could not finish the receipt.";
}

function resetOrder() {
  clearTimeout(state.resetTimer);
  state.quantity = 2;
  state.discountUnlocked = false;
  state.capturedFace = null;
  state.capturedBox = null;
  state.phase = "idle";
  state.paymentIntentId = null;
  state.transactionKey = null;
  state.orderNumber = makeOrderNumber();
  elements.nextOrderButton.hidden = true;
  elements.receiptPreview.open = false;
  clearTransactionStatus();
  resetFaceTracking();
  drawFaceBox(null);
  setCameraMessage("", "Step into view", "Position your face in front of the camera", "⌁");
  setProgress("face", 0, 0);
  renderCurrentReceipt();
  updateOrder();
}

elements.minusButton.addEventListener("click", () => changeQuantity(-1));
elements.plusButton.addEventListener("click", () => changeQuantity(1));
elements.printerSelect.addEventListener("change", () => {
  if (orderIsEditable()) state.transactionKey = null;
  updateOrder();
});
elements.refreshPrinters.addEventListener("click", loadPrinters);
elements.payButton.addEventListener("click", handlePay);
elements.nextOrderButton.addEventListener("click", resetOrder);
elements.cameraRetry.addEventListener("click", initialiseCamera);
window.addEventListener("resize", resizeOverlay);
window.addEventListener("pagehide", destroyVision);
window.addEventListener("pageshow", (event) => {
  if (event.persisted) void initialiseCamera();
});

resizeOverlay();
setProgress("face", 0, 0);
renderCurrentReceipt();
updateOrder();
void document.fonts?.ready.then(renderCurrentReceipt);
await Promise.allSettled([loadConfiguration(), loadPrinters(), initialiseCamera()]);
