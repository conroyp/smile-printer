import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PORTRAIT_PRINT_PROFILE,
  preparePortraitForPrint,
} from "../frontend/receipt-image.js";

function makeImageData(width, height, pixelValue) {
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = pixelValue(x, y);
      const index = (y * width + x) * 4;
      data[index] = value;
      data[index + 1] = value;
      data[index + 2] = value;
      data[index + 3] = 255;
    }
  }

  return { data, width, height };
}

function blackPixelRatio(imageData) {
  let blackPixels = 0;
  for (let index = 0; index < imageData.data.length; index += 4) {
    if (imageData.data[index] === 0) blackPixels += 1;
  }
  return blackPixels / (imageData.width * imageData.height);
}

describe("receipt portrait processing", () => {
  it("produces opaque, strictly black-and-white printer pixels", () => {
    const image = makeImageData(48, 32, (x, y) => (x * 5 + y * 3) % 256);

    preparePortraitForPrint(image);

    for (let index = 0; index < image.data.length; index += 4) {
      assert.ok(image.data[index] === 0 || image.data[index] === 255);
      assert.equal(image.data[index + 1], image.data[index]);
      assert.equal(image.data[index + 2], image.data[index]);
      assert.equal(image.data[index + 3], 255);
    }
  });

  it("expands a shadow-heavy portrait without turning it into a dark block", () => {
    const image = makeImageData(120, 80, (x) => 35 + Math.round((x / 119) * 130));

    preparePortraitForPrint(image);

    const ratio = blackPixelRatio(image);
    assert.ok(ratio > 0.25, `expected retained shadows, got ${ratio}`);
    assert.ok(ratio < 0.55, `expected lifted shadow detail, got ${ratio}`);
  });

  it("does not amplify noise in a nearly flat image", () => {
    const image = makeImageData(32, 24, (x, y) => 118 + ((x + y) % 3));

    preparePortraitForPrint(image);

    const ratio = blackPixelRatio(image);
    assert.ok(ratio > 0.25 && ratio < 0.75, `unexpected flat-tone coverage: ${ratio}`);
  });

  it("exposes the 320 × 410 printer portrait envelope", () => {
    assert.equal(PORTRAIT_PRINT_PROFILE.maxWidth, 320);
    assert.equal(PORTRAIT_PRINT_PROFILE.maxHeight, 410);
  });

  it("rejects inconsistent image buffers", () => {
    assert.throws(
      () => preparePortraitForPrint({ data: new Uint8ClampedArray(4), width: 2, height: 2 }),
      /dimensions do not match/,
    );
  });
});
