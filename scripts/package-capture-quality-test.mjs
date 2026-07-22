import assert from 'node:assert/strict';

import {
  analyzePackageCaptureFrame,
  getPackageCaptureGuidance,
} from '../web/src/packageCaptureQuality.js';

function createFrame(width, height, pixelAt) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = ((y * width) + x) * 4;
      const value = pixelAt(x, y);
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  return { width, height, data };
}

const sharpFrame = createFrame(32, 18, (x, y) => ((x + y) % 2 ? 220 : 40));
const first = analyzePackageCaptureFrame(sharpFrame);
assert.equal(first.acceptable, false);
assert.equal(first.reasonCode, 'stabilizing');
assert.equal(first.luminance.length, 32 * 18);

const stable = analyzePackageCaptureFrame(sharpFrame, first.luminance);
assert.equal(stable.acceptable, true, 'frame iluminado, nitido e parado deve ser aceito');
assert.equal(stable.motion, 0);
assert.ok(stable.qualityScore > 0.7);

const movedFrame = createFrame(32, 18, (x, y) => ((x + y) % 2 ? 40 : 220));
const moving = analyzePackageCaptureFrame(movedFrame, stable.luminance);
assert.equal(moving.acceptable, false);
assert.equal(moving.reasonCode, 'moving');

const darkFrame = createFrame(32, 18, () => 8);
const dark = analyzePackageCaptureFrame(darkFrame, darkFrame.data);
assert.equal(dark.reasonCode, 'too-dark');

const flatFrame = createFrame(32, 18, () => 130);
const flat = analyzePackageCaptureFrame(flatFrame, flatFrame.data);
assert.equal(flat.reasonCode, 'low-contrast');
assert.match(getPackageCaptureGuidance('blurred'), /parado/i);
assert.match(getPackageCaptureGuidance('moving'), /segundos/i);

assert.throws(
  () => analyzePackageCaptureFrame({ width: 2, height: 2, data: [] }),
  /Frame de camera invalido/
);

console.log('Package capture quality tests passed.');
