export const PACKAGE_CAPTURE_SAMPLE_WIDTH = 96;
export const PACKAGE_CAPTURE_SAMPLE_HEIGHT = 54;
export const PACKAGE_CAPTURE_REQUIRED_STABLE_MS = 3000;
export const PACKAGE_CAPTURE_SAMPLE_INTERVAL_MS = 250;

export const PACKAGE_CAPTURE_LIMITS = Object.freeze({
  minimumBrightness: 0.16,
  maximumBrightness: 0.92,
  minimumContrast: 0.12,
  minimumSharpness: 0.055,
  maximumMotion: 0.035,
});

function clampUnit(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

function getLuminance(red, green, blue) {
  return Math.round((red * 0.299) + (green * 0.587) + (blue * 0.114));
}

export function analyzePackageCaptureFrame(imageData, previousLuminance = null) {
  const width = Number.parseInt(imageData?.width, 10) || 0;
  const height = Number.parseInt(imageData?.height, 10) || 0;
  const pixels = imageData?.data;
  const pixelCount = width * height;

  if (!pixels || pixelCount <= 0 || pixels.length < pixelCount * 4) {
    throw new Error('Frame de camera invalido para analise de qualidade.');
  }

  const luminance = new Uint8Array(pixelCount);
  let sum = 0;
  let sumSquares = 0;

  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * 4;
    const value = getLuminance(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
    luminance[index] = value;
    sum += value;
    sumSquares += value * value;
  }

  const average = sum / pixelCount;
  const brightness = average / 255;
  const variance = Math.max(0, (sumSquares / pixelCount) - (average * average));
  const contrast = Math.sqrt(variance) / 128;

  let gradientSum = 0;
  let gradientCount = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width) + x;
      if (x > 0) {
        gradientSum += Math.abs(luminance[index] - luminance[index - 1]);
        gradientCount += 1;
      }
      if (y > 0) {
        gradientSum += Math.abs(luminance[index] - luminance[index - width]);
        gradientCount += 1;
      }
    }
  }
  const sharpness = gradientCount > 0 ? (gradientSum / gradientCount) / 255 : 0;

  const comparablePrevious = previousLuminance instanceof Uint8Array
    && previousLuminance.length === luminance.length;
  let motion = null;
  if (comparablePrevious) {
    let motionSum = 0;
    for (let index = 0; index < luminance.length; index += 1) {
      motionSum += Math.abs(luminance[index] - previousLuminance[index]);
    }
    motion = (motionSum / luminance.length) / 255;
  }

  let reasonCode = '';
  if (brightness < PACKAGE_CAPTURE_LIMITS.minimumBrightness) reasonCode = 'too-dark';
  else if (brightness > PACKAGE_CAPTURE_LIMITS.maximumBrightness) reasonCode = 'too-bright';
  else if (contrast < PACKAGE_CAPTURE_LIMITS.minimumContrast) reasonCode = 'low-contrast';
  else if (sharpness < PACKAGE_CAPTURE_LIMITS.minimumSharpness) reasonCode = 'blurred';
  else if (motion === null) reasonCode = 'stabilizing';
  else if (motion > PACKAGE_CAPTURE_LIMITS.maximumMotion) reasonCode = 'moving';

  const brightnessScore = clampUnit(1 - (Math.abs(brightness - 0.54) / 0.54));
  const contrastScore = clampUnit(contrast / 0.42);
  const sharpnessScore = clampUnit(sharpness / 0.22);
  const motionScore = motion === null
    ? 0
    : clampUnit(1 - (motion / PACKAGE_CAPTURE_LIMITS.maximumMotion));
  const qualityScore = clampUnit(
    (brightnessScore * 0.2)
    + (contrastScore * 0.25)
    + (sharpnessScore * 0.35)
    + (motionScore * 0.2)
  );

  return {
    acceptable: reasonCode === '',
    reasonCode,
    qualityScore,
    brightness,
    contrast,
    sharpness,
    motion,
    luminance,
  };
}

export function getPackageCaptureGuidance(reasonCode) {
  const guidance = {
    'too-dark': 'Aumente a iluminacao sobre o pacote.',
    'too-bright': 'Evite luz direta sobre a etiqueta.',
    'low-contrast': 'Aproxime o pacote e mantenha a etiqueta visivel.',
    blurred: 'Mantenha o pacote parado e centralizado.',
    stabilizing: 'Mantenha o pacote parado por alguns segundos.',
    moving: 'Fique parado por alguns segundos.',
  };
  return guidance[String(reasonCode ?? '')] || 'Posicao adequada. Continue parado.';
}
