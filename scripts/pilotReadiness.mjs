const HEALTHY_UPDATE_STATUSES = new Set(['idle', 'up-to-date', 'healthy']);

function clean(value) {
  return String(value ?? '').trim();
}

function addCheck(checks, id, label, ok, detail) {
  checks.push({ id, label, ok: Boolean(ok), detail: clean(detail) });
}

export function evaluatePilotReadiness(state = {}, options = {}) {
  const runtime = state.runtime || {};
  const device = state.device || {};
  const updater = device.appUpdater || {};
  const policy = state.appUpdate || {};
  const expectedVersion = clean(options.expectedVersion);
  const installedVersion = clean(updater.currentVersionName || device.edgeAppVersion);
  const updateStatus = clean(updater.status) || 'unknown';
  const checkedAtMs = Date.parse(options.checkedAt || new Date().toISOString());
  const lastSeenAtMs = Date.parse(device.lastSeenAt);
  const staleAfterMs = Number(runtime.staleAfterMs || options.staleAfterMs || 90000);
  const deviceFresh = typeof runtime.deviceFresh === 'boolean'
    ? runtime.deviceFresh
    : Number.isFinite(lastSeenAtMs) && Number.isFinite(checkedAtMs) && checkedAtMs - lastSeenAtMs <= staleAfterMs;
  const deviceAuthMode = clean(runtime.deviceAuthMode || options.deviceAuthMode);
  const checks = [];

  addCheck(
    checks,
    'device-fresh',
    'Locker online com sinal recente',
    device.online && deviceFresh,
    device.lastSeenAt || 'Sem ultimo sinal',
  );
  addCheck(
    checks,
    'serial-open',
    'Serial RS-485 aberta',
    device.serialOpen,
    device.serialPath || 'Caminho serial ausente',
  );
  addCheck(
    checks,
    'commissioned',
    'Comissionamento fisico concluido',
    clean(device.commissioningStatus) === 'complete',
    device.commissionedAt || device.commissioningStatus || 'Pendente',
  );
  addCheck(
    checks,
    'device-auth',
    'Autenticacao do dispositivo em HMAC',
    deviceAuthMode === 'hmac',
    deviceAuthMode || 'Nao informado',
  );
  addCheck(
    checks,
    'device-credential',
    'Credencial HMAC provisionada no Android',
    updater.health?.credentialAvailable === true,
    updater.health?.credentialAvailable === true ? 'Disponivel no Keystore' : 'Sem confirmacao do health check',
  );
  addCheck(
    checks,
    'candidate-version',
    'Versao candidata instalada',
    expectedVersion ? installedVersion === expectedVersion : Boolean(installedVersion),
    expectedVersion ? `${installedVersion || 'ausente'} / esperado ${expectedVersion}` : installedVersion || 'Ausente',
  );
  addCheck(
    checks,
    'update-health',
    'Atualizador sem falha ativa',
    HEALTHY_UPDATE_STATUSES.has(updateStatus),
    updateStatus,
  );
  addCheck(
    checks,
    'rollout-scope',
    'Distribuicao limitada ao piloto',
    !policy.enabled || (clean(policy.channel) !== 'production' && Number(policy.rolloutPercentage || 0) <= 10),
    policy.enabled ? `${policy.channel || 'sem canal'} / ${Number(policy.rolloutPercentage || 0)}%` : 'Distribuicao pausada',
  );
  addCheck(
    checks,
    'rollout-health',
    'Rollout sem pausa automatica por falha',
    !policy.autoPausedAt,
    policy.autoPauseReason || 'Sem pausa automatica',
  );
  addCheck(
    checks,
    'door-map',
    'Mapa de portas recebido',
    Array.isArray(state.doors) && state.doors.length > 0 && state.doors.length === Number(device.doorCount || state.doors.length),
    `${Array.isArray(state.doors) ? state.doors.length : 0} portas`,
  );

  const blockingChecks = checks.filter((check) => !check.ok);
  return {
    ready: blockingChecks.length === 0,
    expectedVersion,
    installedVersion,
    checkedAt: clean(options.checkedAt) || new Date().toISOString(),
    readyCount: checks.length - blockingChecks.length,
    totalCount: checks.length,
    blockingCount: blockingChecks.length,
    checks,
  };
}
