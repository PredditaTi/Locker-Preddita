export function createPhysicalDoorProofs(channel, operation = 'dropoff', sequence = 0) {
  const base = Date.UTC(2026, 6, 15, 12, 0, sequence * 3);
  const baselineReadAt = new Date(base).toISOString();
  const openedAt = new Date(base + 1_000).toISOString();
  const closedAt = new Date(base + 2_000).toISOString();
  const cycle = {
    version: 1,
    operation,
    channel,
    sensorPolarity: 'zeroOpen',
    closedStateByte: 0x11,
    openStateByte: 0x00,
    baselineReadAt,
    openedAt,
  };

  return {
    cycle,
    closeProof: {
      version: 1,
      channel,
      sensorPolarity: 'zeroOpen',
      stateByte: 0x11,
      openedAt,
      closedAt,
    },
  };
}
