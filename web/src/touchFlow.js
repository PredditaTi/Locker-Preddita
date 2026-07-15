const DIGIT_PATTERN = /^\d$/;
const COMPLETE_PIN_PATTERN = /^\d{6}$/;

export function applyDigitKey(currentValue, key, maxLength = 6) {
  const current = String(currentValue ?? '').replace(/\D/g, '').slice(0, maxLength);
  const digit = String(key ?? '');

  if (!DIGIT_PATTERN.test(digit) || current.length >= maxLength) {
    return current;
  }

  return `${current}${digit}`.slice(0, maxLength);
}

export function applyBackspaceKey(currentValue) {
  return String(currentValue ?? '').replace(/\D/g, '').slice(0, -1);
}

export function isCompletePin(value) {
  return COMPLETE_PIN_PATTERN.test(String(value ?? ''));
}

export function isDoorClosedForCompletion(status) {
  return status === 'closed';
}

export function shouldShowCourierPickupCredential(delivery) {
  return !String(delivery?.recipientEmail ?? '').trim();
}

export function getCourierSuccessPresentation(delivery) {
  const shouldShowCredential = shouldShowCourierPickupCredential(delivery);

  return {
    title: shouldShowCredential ? 'Anote o PIN' : 'Pronto',
    shouldShowCredential,
    primaryText: 'A encomenda ficou registrada.',
    secondaryText: shouldShowCredential
      ? 'Este apartamento nao tem e-mail cadastrado.'
      : 'O morador recebera o codigo quando o armario sincronizar.',
    autoReturn: !shouldShowCredential,
  };
}

export function getPickupEntryPresentation(mode, value) {
  const isPinMode = mode === 'pin';
  const canSubmit = isPinMode ? isCompletePin(value) : String(value ?? '').trim().length >= 6;

  return {
    title: isPinMode && canSubmit ? 'Abrindo sua porta' : isPinMode ? 'Digite seu PIN' : 'Leia o QR',
    helper: isPinMode && canSubmit
      ? 'Conferindo o codigo recebido.'
      : isPinMode
      ? 'Digite os 6 numeros recebidos.'
      : 'Aponte o QR recebido para a camera.',
    canSubmit,
    shouldAutoSubmit: isPinMode && canSubmit,
  };
}
