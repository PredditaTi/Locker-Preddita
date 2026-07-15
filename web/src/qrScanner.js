import jsQR from 'jsqr';

const PREDDITA_COLLECT_PREFIX = 'preddita://collect?';
const EMPTY_SCAN_ERROR = 'Aponte a camera para um QR de retirada ou digite o PIN.';
const UNKNOWN_SCAN_ERROR = 'Este QR nao e um codigo PREDDITA. Digite o PIN recebido.';

export function resolveScannedPickupCredential(rawValue) {
  const value = String(rawValue ?? '').trim();
  if (!value) {
    return { ok: false, error: EMPTY_SCAN_ERROR };
  }

  if (value.startsWith(PREDDITA_COLLECT_PREFIX)) {
    return { ok: true, mode: 'predditaQr', value };
  }

  const pin = value.replace(/\D/g, '');
  if (pin.length === 6) {
    return { ok: true, mode: 'pin', value: pin };
  }

  return { ok: false, error: UNKNOWN_SCAN_ERROR };
}

export function scanQrFromVideo(videoElement, canvasElement) {
  if (!videoElement || !canvasElement || videoElement.readyState < 2) {
    return '';
  }

  const width = videoElement.videoWidth;
  const height = videoElement.videoHeight;
  if (!width || !height) {
    return '';
  }

  const context = canvasElement.getContext('2d', { willReadFrequently: true });
  if (!context) {
    return '';
  }

  canvasElement.width = width;
  canvasElement.height = height;
  context.drawImage(videoElement, 0, 0, width, height);

  const frame = context.getImageData(0, 0, width, height);
  const result = jsQR(frame.data, frame.width, frame.height, {
    inversionAttempts: 'attemptBoth',
  });

  return result?.data ?? '';
}
