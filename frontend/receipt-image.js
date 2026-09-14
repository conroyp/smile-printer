export const PORTRAIT_PRINT_PROFILE = Object.freeze({
  maxWidth: 320,
  maxHeight: 410,
  blackPointPercentile: 0.02,
  whitePointPercentile: 0.98,
  gamma: 0.8,
  sharpenAmount: 0.45,
  threshold: 128,
});

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function percentileFromHistogram(histogram, pixelCount, percentile) {
  const target = Math.max(1, Math.ceil(pixelCount * percentile));
  let seen = 0;

  for (let value = 0; value < histogram.length; value += 1) {
    seen += histogram[value];
    if (seen >= target) return value;
  }

  return 255;
}

function grayscaleAndNormalise(imageData, profile) {
  const { data, width, height } = imageData;
  const pixelCount = width * height;
  const grey = new Float32Array(pixelCount);
  const histogram = new Uint32Array(256);

  for (let source = 0, pixel = 0; pixel < pixelCount; source += 4, pixel += 1) {
    const luminance = clamp(
      Math.round(0.299 * data[source] + 0.587 * data[source + 1] + 0.114 * data[source + 2]),
      0,
      255,
    );
    grey[pixel] = luminance;
    histogram[luminance] += 1;
  }

  const blackPoint = percentileFromHistogram(
    histogram,
    pixelCount,
    profile.blackPointPercentile,
  );
  const whitePoint = percentileFromHistogram(
    histogram,
    pixelCount,
    profile.whitePointPercentile,
  );
  const shouldNormalise = whitePoint - blackPoint >= 24;
  const range = shouldNormalise ? whitePoint - blackPoint : 255;
  const offset = shouldNormalise ? blackPoint : 0;

  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const normalised = clamp((grey[pixel] - offset) / range, 0, 1);
    grey[pixel] = Math.pow(normalised, profile.gamma) * 255;
  }

  return grey;
}

function sharpen(grey, width, height, amount) {
  if (amount <= 0 || width < 2 || height < 2) return grey;

  const horizontalBlur = new Float32Array(grey.length);
  const blurred = new Float32Array(grey.length);
  const sharpened = new Float32Array(grey.length);

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const left = row + Math.max(0, x - 1);
      const centre = row + x;
      const right = row + Math.min(width - 1, x + 1);
      horizontalBlur[centre] = (grey[left] + grey[centre] + grey[right]) / 3;
    }
  }

  for (let y = 0; y < height; y += 1) {
    const previousRow = Math.max(0, y - 1) * width;
    const row = y * width;
    const nextRow = Math.min(height - 1, y + 1) * width;

    for (let x = 0; x < width; x += 1) {
      const index = row + x;
      blurred[index] =
        (horizontalBlur[previousRow + x] + horizontalBlur[index] + horizontalBlur[nextRow + x]) /
        3;
      sharpened[index] = clamp(grey[index] + amount * (grey[index] - blurred[index]), 0, 255);
    }
  }

  return sharpened;
}

function addError(buffer, width, height, x, y, error) {
  if (x >= 0 && x < width && y >= 0 && y < height) {
    buffer[y * width + x] += error;
  }
}

function ditherAtkinson(grey, width, height, threshold) {
  const working = new Float32Array(grey);
  const output = new Uint8Array(grey.length);

  for (let y = 0; y < height; y += 1) {
    const direction = y % 2 === 0 ? 1 : -1;
    const start = direction === 1 ? 0 : width - 1;
    const end = direction === 1 ? width : -1;

    for (let x = start; x !== end; x += direction) {
      const index = y * width + x;
      const oldValue = clamp(working[index], 0, 255);
      const newValue = oldValue < threshold ? 0 : 255;
      const sharedError = (oldValue - newValue) / 8;
      output[index] = newValue;

      addError(working, width, height, x + direction, y, sharedError);
      addError(working, width, height, x + 2 * direction, y, sharedError);
      addError(working, width, height, x - direction, y + 1, sharedError);
      addError(working, width, height, x, y + 1, sharedError);
      addError(working, width, height, x + direction, y + 1, sharedError);
      addError(working, width, height, x, y + 2, sharedError);
    }
  }

  return output;
}

export function preparePortraitForPrint(imageData, overrides = {}) {
  const profile = { ...PORTRAIT_PRINT_PROFILE, ...overrides };
  const { data, width, height } = imageData;

  if (data.length !== width * height * 4) {
    throw new TypeError("Image data dimensions do not match its pixel buffer.");
  }

  const normalised = grayscaleAndNormalise(imageData, profile);
  const sharpened = sharpen(normalised, width, height, profile.sharpenAmount);
  const monochrome = ditherAtkinson(sharpened, width, height, profile.threshold);

  for (let source = 0, target = 0; source < monochrome.length; source += 1, target += 4) {
    const value = monochrome[source];
    data[target] = value;
    data[target + 1] = value;
    data[target + 2] = value;
    data[target + 3] = 255;
  }

  return imageData;
}
