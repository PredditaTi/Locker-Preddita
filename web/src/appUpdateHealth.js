export const APP_UPDATE_CONFIGURATION_BACKUP_KEY = 'preddita_app_update_config_backup_v1';

function cleanText(value) {
  return String(value ?? '').trim();
}

function integer(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function createConfiguration(state = {}) {
  const deviceConfig = state.deviceConfig && typeof state.deviceConfig === 'object'
    ? state.deviceConfig
    : {};
  const tenant = state.tenant && typeof state.tenant === 'object' ? state.tenant : {};
  const commissioning = deviceConfig.commissioning && typeof deviceConfig.commissioning === 'object'
    ? deviceConfig.commissioning
    : {};

  return {
    tenant: {
      id: cleanText(tenant.id),
      lockerId: cleanText(tenant.lockerId),
    },
    device: {
      board: integer(deviceConfig.board, 1),
      doorCount: integer(deviceConfig.doorCount, 0),
      sensorPolarity: cleanText(deviceConfig.sensorPolarity),
      unlockTimeoutSeconds: integer(deviceConfig.unlockTimeoutSeconds, 0),
      doorSizes: Array.isArray(deviceConfig.doorSizes)
        ? deviceConfig.doorSizes.map((size) => cleanText(size).toUpperCase())
        : [],
      commissioning: {
        status: cleanText(commissioning.status),
        completedAt: cleanText(commissioning.completedAt),
      },
    },
  };
}

function hasValidConfiguration(configuration = {}) {
  const device = configuration.device ?? {};
  return Number.isInteger(device.board)
    && device.board >= 1
    && device.board <= 31
    && Number.isInteger(device.doorCount)
    && device.doorCount >= 1
    && device.doorCount <= 24
    && ['zeroClosed', 'zeroOpen'].includes(device.sensorPolarity)
    && Number.isInteger(device.unlockTimeoutSeconds)
    && device.unlockTimeoutSeconds >= 1
    && device.unlockTimeoutSeconds <= 30
    && Array.isArray(device.doorSizes)
    && device.doorSizes.length === device.doorCount
    && device.doorSizes.every((size) => ['P', 'M', 'G'].includes(size));
}

export function saveAppUpdateConfigurationBackup({ storage, state, manifest, now } = {}) {
  if (!storage || !manifest || typeof manifest !== 'object') {
    return { ok: false, errorCode: 'CONFIGURATION_BACKUP_STORAGE_UNAVAILABLE' };
  }
  const configuration = createConfiguration(state);
  if (!hasValidConfiguration(configuration)) {
    return { ok: false, errorCode: 'CONFIGURATION_BACKUP_SOURCE_INVALID' };
  }

  const backup = {
    schemaVersion: 1,
    releaseId: cleanText(manifest.releaseId),
    targetVersionCode: integer(manifest.versionCode),
    createdAt: typeof now === 'function' ? cleanText(now()) : new Date().toISOString(),
    configuration,
  };
  try {
    storage.setItem(APP_UPDATE_CONFIGURATION_BACKUP_KEY, JSON.stringify(backup));
    return { ok: true, backup };
  } catch (_error) {
    return { ok: false, errorCode: 'CONFIGURATION_BACKUP_WRITE_FAILED' };
  }
}

export function validateAppUpdateConfigurationBackup({ storage, state, updaterStatus } = {}) {
  if (!storage) {
    return { checked: true, valid: false, errorCode: 'CONFIGURATION_BACKUP_STORAGE_UNAVAILABLE' };
  }
  try {
    const raw = storage.getItem(APP_UPDATE_CONFIGURATION_BACKUP_KEY);
    if (!raw) {
      return { checked: true, valid: false, errorCode: 'CONFIGURATION_BACKUP_MISSING' };
    }
    const backup = JSON.parse(raw);
    if (backup?.schemaVersion !== 1) {
      return { checked: true, valid: false, errorCode: 'CONFIGURATION_BACKUP_SCHEMA_UNSUPPORTED' };
    }
    if (
      cleanText(backup.releaseId) !== cleanText(updaterStatus?.releaseId)
      || integer(backup.targetVersionCode) !== integer(updaterStatus?.targetVersionCode)
    ) {
      return { checked: true, valid: false, errorCode: 'CONFIGURATION_BACKUP_RELEASE_MISMATCH' };
    }

    const current = createConfiguration(state);
    if (!hasValidConfiguration(current)) {
      return { checked: true, valid: false, errorCode: 'STATE_CONFIGURATION_INVALID' };
    }
    if (JSON.stringify(backup.configuration) !== JSON.stringify(current)) {
      return { checked: true, valid: false, errorCode: 'CONFIGURATION_BACKUP_INCOMPATIBLE' };
    }
    return { checked: true, valid: true, errorCode: '' };
  } catch (_error) {
    return { checked: true, valid: false, errorCode: 'CONFIGURATION_BACKUP_READ_FAILED' };
  }
}
