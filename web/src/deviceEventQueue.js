function cleanId(value) {
  return String(value ?? '').trim();
}

export function buildDeliveryStoredEventId(deliveryId) {
  const safeId = cleanId(deliveryId);
  return safeId ? `edge-delivery-stored-${safeId}` : '';
}

export function buildDeliveryCollectedEventId(deliveryId) {
  const safeId = cleanId(deliveryId);
  return safeId ? `edge-delivery-collected-${safeId}` : '';
}

export function upsertDeviceEventQueue(queue, event, maxItems = 160) {
  const safeQueue = Array.isArray(queue) ? queue : [];
  const safeEvent = event && typeof event === 'object' ? event : null;
  const safeId = cleanId(safeEvent?.id);
  const safeType = cleanId(safeEvent?.type);

  if (!safeId || !safeType) {
    return safeQueue.slice(-maxItems);
  }

  return [
    ...safeQueue.filter((item) => cleanId(item?.id) !== safeId),
    { ...safeEvent, id: safeId, type: safeType },
  ].slice(-maxItems);
}
