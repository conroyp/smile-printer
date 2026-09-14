import { PORTRAIT_PRINT_PROFILE, preparePortraitForPrint } from "./receipt-image.js";

const RECEIPT_WIDTH = 384;
const RECEIPT_EDGE = 22;
const RECEIPT_CENTRE = RECEIPT_WIDTH / 2;
const MONOCHROME_THRESHOLD = 190;

// Extra paper lets the final line clear the V660p tear bar.
export const RECEIPT_BOTTOM_FEED_PX = 72;

function forceMonochrome(canvas, context) {
  const image = context.getImageData(0, 0, canvas.width, canvas.height);

  for (let index = 0; index < image.data.length; index += 4) {
    const luminance =
      0.299 * image.data[index] +
      0.587 * image.data[index + 1] +
      0.114 * image.data[index + 2];
    const value = luminance < MONOCHROME_THRESHOLD ? 0 : 255;
    image.data[index] = value;
    image.data[index + 1] = value;
    image.data[index + 2] = value;
    image.data[index + 3] = 255;
  }

  context.putImageData(image, 0, 0);
}

function drawDivider(context, y, dashed = true) {
  context.save();
  context.strokeStyle = "#000";
  context.lineWidth = 2;
  context.setLineDash(dashed ? [6, 5] : []);
  context.beginPath();
  context.moveTo(RECEIPT_EDGE, y);
  context.lineTo(RECEIPT_WIDTH - RECEIPT_EDGE, y);
  context.stroke();
  context.restore();
}

function drawRow(context, label, value, y, bold = false) {
  context.fillStyle = "#000";
  context.font = `${bold ? "bold " : ""}16px "DM Mono", monospace`;
  context.textAlign = "left";
  context.fillText(label, RECEIPT_EDGE, y);
  context.textAlign = "right";
  context.fillText(value, RECEIPT_WIDTH - RECEIPT_EDGE, y);
}

function preparePhoto(source, ownerDocument) {
  const scale = Math.min(
    PORTRAIT_PRINT_PROFILE.maxWidth / source.width,
    PORTRAIT_PRINT_PROFILE.maxHeight / source.height,
  );
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const canvas = ownerDocument.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, width, height);

  const pixels = context.getImageData(0, 0, width, height);
  context.putImageData(preparePortraitForPrint(pixels), 0, 0);
  return canvas;
}

export function renderReceipt(canvas, order, formatMoney) {
  const {
    capturedFace,
    discount,
    discountPercentage,
    discountUnlocked,
    orderNumber,
    quantity,
    subtotal,
    total,
  } = order;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const photo = capturedFace ? preparePhoto(capturedFace, canvas.ownerDocument) : null;

  canvas.width = RECEIPT_WIDTH;
  canvas.height = photo ? 820 : 438;
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#000";
  context.textAlign = "center";
  context.font = "bold 27px 'DM Mono', monospace";
  context.fillText("SMILE COFFEE", RECEIPT_CENTRE, 42);
  context.font = "12px 'DM Mono', monospace";
  context.fillText("GOOD COFFEE · GOOD MOOD", RECEIPT_CENTRE, 66);
  drawDivider(context, 86);

  let y = 116;
  if (photo) {
    context.drawImage(photo, Math.round((RECEIPT_WIDTH - photo.width) / 2), y);
    y += photo.height + 24;
    context.font = "bold 14px 'DM Mono', monospace";
    context.fillText(`THAT SMILE SAVED ${discountPercentage}%!`, RECEIPT_CENTRE, y);
    y += 24;
  } else {
    context.font = "bold 18px 'DM Mono', monospace";
    context.fillText(":)", RECEIPT_CENTRE, y + 15);
    context.font = "12px 'DM Mono', monospace";
    context.fillText(
      `SMILE TO UNLOCK ${discountPercentage}% OFF`,
      RECEIPT_CENTRE,
      y + 43,
    );
    y += 72;
  }

  drawDivider(context, y);
  y += 31;
  drawRow(context, `${quantity} x House coffee`, formatMoney(subtotal), y);
  y += 28;
  if (discountUnlocked) {
    drawRow(
      context,
      `Smile discount (${discountPercentage}%)`,
      `-${formatMoney(discount)}`,
      y,
    );
    y += 28;
  }
  drawDivider(context, y, false);
  y += 33;
  drawRow(context, "TOTAL", formatMoney(total), y, true);
  y += 34;
  context.textAlign = "center";
  context.font = "11px 'DM Mono', monospace";
  context.fillText(`ORDER #${orderNumber}`, RECEIPT_CENTRE, y);
  y += 21;
  context.fillText("THANKS FOR BRIGHTENING OUR DAY", RECEIPT_CENTRE, y);

  const requiredHeight = y + RECEIPT_BOTTOM_FEED_PX;
  if (requiredHeight < canvas.height) {
    const snapshot = context.getImageData(0, 0, canvas.width, requiredHeight);
    canvas.height = requiredHeight;
    context.putImageData(snapshot, 0, 0);
  }
  forceMonochrome(canvas, context);
}
