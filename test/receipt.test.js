import assert from "node:assert/strict";
import { it } from "node:test";
import { RECEIPT_BOTTOM_FEED_PX, renderReceipt } from "../frontend/receipt.js";

function mockCanvas() {
  const strokeWidths = [];
  const text = [];
  const context = {
    beginPath() {},
    fillRect() {},
    fillText(value, x, y) {
      text.push({ value, x, y });
    },
    getImageData(_x, _y, width, height) {
      const data = new Uint8ClampedArray(width * height * 4);
      data.fill(255);
      return { data, width, height };
    },
    lineTo() {},
    moveTo() {},
    putImageData() {},
    restore() {},
    save() {},
    setLineDash() {},
    stroke() {
      strokeWidths.push(this.lineWidth);
    },
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext() {
      return context;
    },
  };

  return { canvas, strokeWidths, text };
}

it("renders configured discount copy and leaves feed space after the footer", () => {
  const { canvas, strokeWidths, text } = mockCanvas();

  renderReceipt(
    canvas,
    {
      capturedFace: null,
      discount: 0,
      discountPercentage: 10,
      discountUnlocked: false,
      orderNumber: "1234",
      quantity: 2,
      subtotal: 860,
      total: 860,
    },
    (amount) => `€${(amount / 100).toFixed(2)}`,
  );

  assert.ok(text.some(({ value }) => value === "SMILE TO UNLOCK 10% OFF"));
  assert.ok(text.some(({ value }) => value === "2 x House coffee"));
  const footer = text.find(({ value }) => value === "THANKS FOR BRIGHTENING OUR DAY");
  assert.equal(canvas.width, 384);
  assert.equal(canvas.height, footer.y + RECEIPT_BOTTOM_FEED_PX);
  assert.ok(strokeWidths.every((width) => width >= 2));
});
