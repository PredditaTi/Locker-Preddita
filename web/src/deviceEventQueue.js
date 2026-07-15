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

export function applyDeviceEventSyncResult(queue, result, attemptedAt, maxItems = 160) {
  const safeQueue = Array.isArray(queue) ? queue : [];
  const acceptedIds = new Set(
    (Array.isArray(result?.acceptedIds) ? result.acceptedIds : []).map(cleanId).filter(Boolean)
  );
  const failedIds = new Set(
    (Array.isArray(result?.failedEvents) ? result.failedEvents : [])
      .map((item) => cleanId(item?.id))
      .filter((id) => id && !acceptedIds.has(id))
  );
  const attemptTime = cleanId(attemptedAt);
  const remaining = safeQueue.filter((item) => {
    const id = cleanId(item?.id);
    return !acceptedIds.has(id) && !failedIds.has(id);
  });
  const failed = safeQueue
    .filter((item) => failedIds.has(cleanId(item?.id)))
    .map((item) => ({
      ...item,
      attempts: Math.max(0, Number(item?.attempts) || 0) + 1,
      lastAttemptAt: attemptTime,
    }));

  return {
    pending: [...remaining, ...failed].slice(-maxItems),
    acceptedIds: [...acceptedIds],
    failed,
  };
}
