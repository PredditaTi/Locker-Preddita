const API = '';

const state = {
  view: 'overview',
  data: null,
  session: null,
  csrfToken: '',
  editingResidentId: '',
  residentDrafts: {
    new: {},
    edit: {},
  },
  lastRole: '',
  trackingCommandId: '',
  trackingCommand: null,
  mfa: null,
  recoveryCodes: [],
  operationalLogs: {
    items: [],
    nextCursor: '',
    loading: false,
    loaded: false,
    retentionDays: 30,
    filters: { level: '', source: '', event: '', query: '' },
  },
  privacy: {
    summary: null,
    loading: false,
  },
};

const root = document.querySelector('#view-root');
const adminApp = document.querySelector('#admin-app');
const loginScreen = document.querySelector('#login-screen');
const loginForm = document.querySelector('#login-form');
const loginUsername = document.querySelector('#login-username');
const loginPassword = document.querySelector('#login-password');
const loginButton = document.querySelector('#login-button');
const loginMessage = document.querySelector('#login-message');
const mfaForm = document.querySelector('#mfa-form');
const mfaTitle = document.querySelector('#mfa-title');
const mfaDescription = document.querySelector('#mfa-description');
const mfaEnrollment = document.querySelector('#mfa-enrollment');
const mfaQr = document.querySelector('#mfa-qr');
const mfaSecret = document.querySelector('#mfa-secret');
const mfaCodeLabel = document.querySelector('#mfa-code-label');
const mfaCode = document.querySelector('#mfa-code');
const mfaRecoveryLabel = document.querySelector('#mfa-recovery-label');
const mfaRecoveryCode = document.querySelector('#mfa-recovery-code');
const mfaButton = document.querySelector('#mfa-button');
const mfaRecoveryToggle = document.querySelector('#mfa-recovery-toggle');
const mfaBackButton = document.querySelector('#mfa-back-button');
const mfaMessage = document.querySelector('#mfa-message');
const mfaRecoveryCodes = document.querySelector('#mfa-recovery-codes');
const recoveryCodeList = document.querySelector('#recovery-code-list');
const recoveryMessage = document.querySelector('#recovery-message');
const title = document.querySelector('#view-title');
const siteName = document.querySelector('#site-name');
const message = document.querySelector('#message');
const deviceStatus = document.querySelector('#device-status');
const navList = document.querySelector('#nav-list');
const panelName = document.querySelector('#panel-name');
const panelDescription = document.querySelector('#panel-description');
const sessionName = document.querySelector('#session-name');
const sessionRole = document.querySelector('#session-role');

const NAV_BY_ROLE = {
  sindico: [
    ['overview', 'Resumo'],
    ['doors', 'Portas'],
    ['residents', 'Apartamentos'],
    ['deliveries', 'Entregas'],
    ['audit', 'Auditoria'],
    ['privacy', 'Privacidade'],
  ],
  operador: [
    ['overview', 'Resumo'],
    ['doors', 'Portas'],
    ['deliveries', 'Entregas'],
    ['audit', 'Auditoria'],
  ],
  suporte: [
    ['platform', 'Operacao'],
    ['overview', 'Armario atual'],
    ['doors', 'Portas'],
    ['deliveries', 'Entregas'],
    ['audit', 'Auditoria'],
    ['pilot', 'Piloto'],
    ['updates', 'Atualizacoes'],
    ['logs', 'Logs'],
    ['system', 'Sistema'],
  ],
  super_admin: [
    ['platform', 'Admin geral'],
    ['overview', 'Armario atual'],
    ['doors', 'Portas'],
    ['residents', 'Apartamentos'],
    ['deliveries', 'Entregas'],
    ['audit', 'Auditoria'],
    ['pilot', 'Piloto'],
    ['updates', 'Atualizacoes'],
    ['logs', 'Logs'],
    ['privacy', 'Privacidade'],
    ['system', 'Sistema'],
  ],
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function residentTitle(resident) {
  return resident.apartment ? `Apartamento ${resident.apartment}` : 'Apartamento sem numero';
}

function deliveryUnitLabel(delivery = {}) {
  return delivery.unit || delivery.apartment || delivery.recipientName || 'Apartamento nao informado';
}

function isActiveDelivery(delivery = {}) {
  return ['door_opened_for_dropoff', 'stored', 'pickup_opened'].includes(String(delivery.status || ''));
}

function deliveryStatusLabel(status) {
  const labels = {
    door_opened_for_dropoff: 'Aguardando deposito',
    stored: 'Guardada',
    pickup_opened: 'Porta aberta para retirada',
    collected: 'Retirada',
    cancelled: 'Cancelada',
  };
  return labels[status] || status || 'Sem status';
}

function appUpdateStatusLabel(status) {
  return {
    idle: 'Aguardando',
    offered: 'Oferta recebida',
    downloading: 'Baixando',
    downloaded: 'Download verificado',
    'awaiting-permission': 'Aguardando permissao',
    installing: 'Instalador aberto',
    failed: 'Falha',
    'up-to-date': 'Atualizado',
    'installed-pending-health': 'Validando nova versao',
    healthy: 'Saudavel',
    degraded: 'Operacao degradada',
    'failed-health': 'Falha no health check',
  }[status] || 'Sem telemetria';
}

function pilotOutcomeLabel(outcome) {
  return {
    completed: 'Concluida',
    cancelled: 'Cancelada',
    failed: 'Falhou',
    interrupted: 'Interrompida',
  }[outcome] || 'Sem resultado';
}

function pilotJourneyLabel(journeyType) {
  return journeyType === 'courier' ? 'Entrega' : 'Retirada';
}

function formatPilotDuration(durationMs) {
  const seconds = Math.max(0, Math.round((Number(durationMs) || 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}min ${seconds % 60}s`;
}

function doorSizeLabel(size) {
  if (size === 'G') return 'Grande';
  if (size === 'M') return 'Media';
  return 'Pequena';
}

function doorSensorLabel(status) {
  if (status === 'open') return 'Sensor aberto';
  if (status === 'closed') return 'Sensor fechado';
  return 'Sem leitura';
}

function doorActionLabel(door) {
  return door.occupancy === 'busy' ? 'Abrir e liberar' : 'Abrir remotamente';
}

function unitLabel(resident) {
  const parts = [];
  if (resident.building) parts.push(resident.building);
  if (resident.floor) parts.push(`${resident.floor} andar`);
  if (resident.apartment) parts.push(`Ap ${resident.apartment}`);
  return parts.join(' - ') || residentTitle(resident);
}

function notificationLabel(delivery) {
  if (delivery.notificationStatus === 'sent') return `E-mail enviado${delivery.notificationSentAt ? ` em ${delivery.notificationSentAt}` : ''}`;
  if (delivery.notificationStatus === 'pending') return 'E-mail em envio';
  if (delivery.notificationStatus === 'failed') return `E-mail falhou: ${delivery.notificationError || 'verifique SMTP'}`;
  if (delivery.notificationStatus === 'skipped') return delivery.notificationError || 'E-mail nao enviado';
  return delivery.recipientEmail ? 'E-mail ainda nao processado' : 'Apartamento sem e-mail';
}

function deliveryStoredAgeHours(delivery = {}) {
  if (delivery.status !== 'stored') return 0;
  const storedAt = Date.parse(delivery.depositedAt || delivery.createdAt);
  if (!Number.isFinite(storedAt)) return 0;
  return Math.max(0, (Date.now() - storedAt) / 3600000);
}

function deliveryAgeLabel(delivery = {}) {
  if (delivery.status !== 'stored') return deliveryStatusLabel(delivery.status);
  const hours = deliveryStoredAgeHours(delivery);
  if (hours < 1) return 'Guardada ha menos de 1h';
  if (hours < 24) return `Guardada ha ${Math.floor(hours)}h`;
  return `Guardada ha ${Math.floor(hours / 24)} dia${hours >= 48 ? 's' : ''}`;
}

function deliveryAgeClass(delivery = {}) {
  const hours = deliveryStoredAgeHours(delivery);
  if (hours >= 72) return 'is-critical';
  if (hours >= 48) return 'is-warning';
  if (hours >= 24) return 'is-attention';
  return '';
}

function deliveryEvidenceLabel(delivery = {}) {
  if (delivery.labelPhotoDataUrl) return `Foto da etiqueta${delivery.labelPhotoCapturedAt ? ` em ${delivery.labelPhotoCapturedAt}` : ''}`;
  if (delivery.labelPhotoCapturedAt) return `Foto protegida registrada em ${delivery.labelPhotoCapturedAt}`;
  if (delivery.labelProofRequired) return 'Sem foto da etiqueta';
  return 'Comprovante nao solicitado';
}

function deliveryReminderLabel(delivery = {}) {
  const level = Number(delivery.reminderLevel) || 0;
  if (level <= 0) return 'Sem lembrete automatico ainda';
  if (delivery.reminderError) return `Lembrete ${level} falhou: ${delivery.reminderError}`;
  const suffix = delivery.reminderLastSentAt ? ` enviado em ${delivery.reminderLastSentAt}` : ' enfileirado';
  return `Lembrete ${level}${suffix}`;
}

function runtime() {
  return state.data?.runtime || {};
}

function session() {
  return state.session || state.data?.session || { role: 'operador', label: 'Sessao administrativa' };
}

function roleNavItems() {
  return NAV_BY_ROLE[session().role] || NAV_BY_ROLE.sindico;
}

function isSuperAdmin() {
  return session().role === 'super_admin';
}

function roleLabel(role) {
  return {
    sindico: 'Sindico',
    operador: 'Operador',
    suporte: 'Suporte tecnico',
    super_admin: 'Admin Geral',
  }[role] || 'Usuario';
}

function isDeviceReady() {
  return Boolean(state.data?.device?.online && !state.data?.device?.stale && state.data?.device?.serialOpen);
}

function formatAge(ms) {
  if (!Number.isFinite(Number(ms))) return 'sem sinal';
  if (ms < 1000) return 'agora';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s atras`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}min atras`;
  return `${Math.floor(minutes / 60)}h atras`;
}

function commandStatusLabel(command) {
  if (!command) return 'Nenhum comando em acompanhamento';
  if (command.status === 'pending') return 'Aguardando armario buscar';
  if (command.status === 'leased') return 'Reservado para o armario';
  if (command.status === 'executing') return 'Armario executando';
  if (command.status === 'completed') return command.result?.confirmed ? 'Aberta e confirmada' : 'Executada sem confirmacao do sensor';
  if (command.status === 'failed') return 'Falhou';
  return command.status || 'Status desconhecido';
}

function renderCommandTracker() {
  const command = state.trackingCommand || (state.data?.commands || [])[0];
  if (!command) return '';
  const timeline = command.timeline || [];
  return `
    <section class="panel command-tracker ${command.status === 'failed' ? 'is-danger' : ''}">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Comando remoto</p>
          <h3>${escapeHtml(commandStatusLabel(command))}</h3>
        </div>
        <span class="tag">${escapeHtml(command.status)}</span>
      </div>
      <p class="muted">Porta ${escapeHtml(command.door)} | ${escapeHtml(command.reason || 'Sem motivo informado')}</p>
      ${command.result?.error ? `<p class="small is-danger-text">${escapeHtml(command.result.error)}</p>` : ''}
      <div class="timeline">
        ${timeline.map((item) => `
          <div class="timeline-item">
            <strong>${escapeHtml(item.status)}</strong>
            <span>${escapeHtml(item.detail || '')}</span>
            <small>${escapeHtml(item.at || '')}</small>
          </div>
        `).join('')}
      </div>
    </section>
  `;
}

function renderSecurityWarnings() {
  const warnings = runtime().securityWarnings || [];
  if (!warnings.length) return '';
  return `
    <div class="warning-list">
      ${warnings.map((warning) => `<p>${escapeHtml(warning)}</p>`).join('')}
    </div>
  `;
}

function formatResidentSyncStatus() {
  const data = state.data || {};
  const panelCount = (data.residents || []).length;
  const deviceCount = Number.parseInt(data.device?.residentCount, 10);

  if (!data.device?.online || !data.device?.lastSeenAt) {
    return 'O armario atualiza quando voltar a ficar online.';
  }

  if (!Number.isFinite(deviceCount)) {
    return 'Armario online. Aguardando primeira confirmacao da lista de apartamentos.';
  }

  if (deviceCount === panelCount) {
    return `Sincronizado no armario: ${deviceCount} apartamentos.`;
  }

  return `Painel com ${panelCount} apartamentos. Armario ainda confirmou ${deviceCount}; aguarde alguns segundos.`;
}

function showMessage(text, error = false) {
  message.hidden = false;
  message.textContent = text;
  message.className = error ? 'message is-error' : 'message';
  window.clearTimeout(showMessage.timer);
  showMessage.timer = window.setTimeout(() => {
    message.hidden = true;
  }, 4200);
}

function showLogin(error = '') {
  state.session = null;
  state.csrfToken = '';
  state.data = null;
  state.mfa = null;
  state.recoveryCodes = [];
  adminApp.hidden = true;
  loginScreen.hidden = false;
  loginForm.hidden = false;
  mfaForm.hidden = true;
  mfaRecoveryCodes.hidden = true;
  loginMessage.textContent = error;
  loginMessage.hidden = !error;
  loginPassword.value = '';
  window.setTimeout(() => loginUsername.focus(), 0);
}

function setMfaRecoveryMode(enabled) {
  if (!state.mfa) return;
  const recoveryEnabled = Boolean(enabled && !state.mfa.enrollment);
  state.mfa.recoveryMode = recoveryEnabled;
  mfaCodeLabel.hidden = recoveryEnabled;
  mfaCode.hidden = recoveryEnabled;
  mfaCode.required = !recoveryEnabled;
  mfaRecoveryLabel.hidden = !recoveryEnabled;
  mfaRecoveryCode.hidden = !recoveryEnabled;
  mfaRecoveryCode.required = recoveryEnabled;
  mfaRecoveryToggle.textContent = recoveryEnabled
    ? 'Usar codigo do autenticador'
    : 'Usar codigo de recuperacao';
  mfaMessage.hidden = true;
  window.setTimeout(() => (recoveryEnabled ? mfaRecoveryCode : mfaCode).focus(), 0);
}

function showMfa(mfa) {
  state.mfa = { ...mfa, recoveryMode: false };
  state.recoveryCodes = [];
  loginForm.hidden = true;
  mfaRecoveryCodes.hidden = true;
  mfaForm.hidden = false;
  mfaEnrollment.hidden = !mfa.enrollment;
  mfaTitle.textContent = mfa.enrollment ? 'Proteja sua conta' : 'Confirme seu acesso';
  mfaDescription.textContent = mfa.enrollment
    ? 'Escaneie o QR code e confirme com o primeiro codigo gerado.'
    : 'Digite o codigo atual do seu aplicativo autenticador.';
  mfaQr.hidden = !mfa.qrDataUrl;
  mfaQr.src = mfa.qrDataUrl || '';
  mfaSecret.textContent = mfa.secret || '';
  mfaCode.value = '';
  mfaRecoveryCode.value = '';
  mfaRecoveryToggle.hidden = Boolean(mfa.enrollment);
  mfaMessage.hidden = true;
  setMfaRecoveryMode(false);
  window.setTimeout(() => mfaCode.focus(), 0);
}

function acceptAuthenticatedSession(payload) {
  state.session = payload.session;
  state.csrfToken = payload.session.csrfToken;
  state.lastRole = '';
  state.mfa = null;
}

function showRecoveryCodes(codes) {
  state.recoveryCodes = [...codes];
  loginForm.hidden = true;
  mfaForm.hidden = true;
  mfaRecoveryCodes.hidden = false;
  recoveryCodeList.replaceChildren(...codes.map((code) => {
    const item = document.createElement('li');
    item.textContent = code;
    return item;
  }));
  recoveryMessage.textContent = '';
}

function showAdmin() {
  loginScreen.hidden = true;
  loginMessage.hidden = true;
  adminApp.hidden = false;
}

async function authRequest(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function api(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const csrfHeaders = ['GET', 'HEAD', 'OPTIONS'].includes(method) || !state.csrfToken
    ? {}
    : { 'x-csrf-token': state.csrfToken };
  const response = await fetch(`${API}${path}`, {
    ...options,
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      ...csrfHeaders,
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) {
    showLogin('Sua sessao expirou. Entre novamente.');
  }
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || 'Falha na API.');
  }
  return payload;
}

async function downloadAdminFile(path, filename) {
  const response = await fetch(`${API}${path}`, {
    credentials: 'same-origin',
  });
  if (response.status === 401) showLogin('Sua sessao expirou. Entre novamente.');
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || 'Falha ao exportar arquivo.');
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function loadState(options = {}) {
  if (!options.skipCapture) captureResidentDrafts();
  const payload = await api('/api/admin/state');
  state.data = payload.state;
  ensureAllowedView();
  render();
}

async function refreshState(options = {}) {
  if (!options.skipCapture) captureResidentDrafts();
  const payload = await api('/api/admin/state');
  state.data = payload.state;
  ensureAllowedView();

  if (options.skipRenderWhileEditing && isResidentFormActive()) {
    updateChrome();
    return;
  }

  render();
}

function ensureAllowedView() {
  const role = session().role;
  const allowed = roleNavItems().map(([view]) => view);
  if (state.lastRole !== role) {
    state.view = session().canViewPlatform ? 'platform' : 'overview';
    state.lastRole = role;
    return;
  }
  if (!allowed.includes(state.view)) {
    state.view = allowed[0] || 'overview';
  }
}

function renderNav() {
  navList.innerHTML = roleNavItems()
    .map(([view, label]) => `<button class="nav-button ${state.view === view ? 'is-active' : ''}" data-view="${escapeHtml(view)}">${escapeHtml(label)}</button>`)
    .join('');
}

function updateChrome() {
  const data = state.data;
  const currentSession = session();
  panelName.textContent = roleLabel(currentSession.role);
  panelDescription.textContent = currentSession.canViewPlatform
    ? 'Operacao, suporte, armarios e seguranca.'
    : 'Portas, apartamentos e entregas do condominio.';
  sessionName.textContent = currentSession.name || currentSession.username || 'Usuario';
  sessionRole.textContent = roleLabel(currentSession.role);
  siteName.textContent = currentSession.canViewPlatform ? 'PREDDITA Operacao' : data?.tenant?.siteName || 'PREDDITA';
  const isOnline = isDeviceReady();
  deviceStatus.textContent = isOnline ? 'Armario pronto' : data?.device?.stale ? 'Armario sem sinal recente' : 'Aguardando armario';
  deviceStatus.className = isOnline ? 'status-pill' : 'status-pill is-offline';
  deviceStatus.title = currentSession.label || '';
  renderNav();
}

function setView(view) {
  captureResidentDrafts();
  if (!roleNavItems().some(([allowedView]) => allowedView === view)) return;
  state.view = view;
  render();
  if (view === 'logs' && !state.operationalLogs.loaded) {
    void loadOperationalLogs().catch((error) => showMessage(error.message, true));
  }
  if (view === 'privacy') {
    void loadPrivacySummary().catch((error) => showMessage(error.message, true));
  }
}

function operationalLogQuery(options = {}) {
  const filters = state.operationalLogs.filters;
  const params = new URLSearchParams();
  const lockerId = state.data?.tenant?.lockerId;
  if (lockerId) params.set('lockerId', lockerId);
  if (filters.level) params.set('level', filters.level);
  if (filters.source) params.set('source', filters.source);
  if (filters.event) params.set('event', filters.event);
  if (filters.query) params.set('q', filters.query);
  if (options.cursor) params.set('cursor', options.cursor);
  if (options.limit) params.set('limit', options.limit);
  return params.toString();
}

async function loadOperationalLogs(options = {}) {
  if (!session().canViewOperationalLogs || state.operationalLogs.loading) return;
  state.operationalLogs.loading = true;
  if (state.view === 'logs') renderLogs();
  try {
    const cursor = options.append ? state.operationalLogs.nextCursor : '';
    const payload = await api(`/api/admin/logs?${operationalLogQuery({ cursor, limit: 50 })}`);
    state.operationalLogs.items = options.append
      ? [...state.operationalLogs.items, ...(payload.logs || [])]
      : payload.logs || [];
    state.operationalLogs.nextCursor = payload.nextCursor || '';
    state.operationalLogs.retentionDays = payload.retentionDays || 30;
    state.operationalLogs.loaded = true;
  } finally {
    state.operationalLogs.loading = false;
    if (state.view === 'logs') renderLogs();
  }
}

async function loadPrivacySummary() {
  if (!session().canManagePrivacy || state.privacy.loading) return;
  state.privacy.loading = true;
  if (state.view === 'privacy') renderPrivacy();
  try {
    const payload = await api('/api/admin/privacy');
    state.privacy.summary = payload.privacy;
  } finally {
    state.privacy.loading = false;
    if (state.view === 'privacy') renderPrivacy();
  }
}

function getResidentFormValues(form) {
  const values = Object.fromEntries(new FormData(form).entries());
  Object.keys(values).forEach((key) => {
    values[key] = String(values[key] ?? '');
  });
  return values;
}

function getResidentFormKey(form) {
  const id = form.elements.id?.value;
  return id ? `edit:${id}` : 'new';
}

function storeResidentDraft(form) {
  const values = getResidentFormValues(form);
  const key = getResidentFormKey(form);

  if (key === 'new') {
    state.residentDrafts.new = values;
    return;
  }

  state.residentDrafts.edit[values.id] = values;
}

function captureResidentDrafts() {
  if (state.view !== 'residents') return;
  document.querySelectorAll('.resident-form').forEach((form) => storeResidentDraft(form));
}

function isResidentFormActive() {
  return state.view === 'residents' && !!document.activeElement?.closest?.('.resident-form');
}

function getResidentFormDraft(resident = {}) {
  if (resident.id) {
    return {
      ...resident,
      ...(state.residentDrafts.edit[resident.id] || {}),
    };
  }

  return state.residentDrafts.new || {};
}

function renderStats() {
  const data = state.data;
  const doors = data.doors || [];
  const residents = data.residents || [];
  const deliveries = data.deliveries || [];
  const health = runtime();
  const activeDeliveries = deliveries.filter(isActiveDelivery);
  const deviceResidentCount = Number.isFinite(Number.parseInt(data.device?.residentCount, 10))
    ? Number.parseInt(data.device.residentCount, 10)
    : '--';
  const pending = (data.commands || []).filter((command) =>
    ['pending', 'leased', 'executing'].includes(command.status)
  );
  return `
    <div class="grid stats">
      <article class="stat-card"><span class="muted">Apartamentos no painel</span><strong>${residents.length}</strong></article>
      <article class="stat-card"><span class="muted">No armario</span><strong>${deviceResidentCount}</strong></article>
      <article class="stat-card"><span class="muted">Pequenas livres</span><strong>${escapeHtml(health.freeSmallDoorCount ?? doors.filter((door) => door.size === 'P' && door.occupancy !== 'busy').length)}</strong></article>
      <article class="stat-card"><span class="muted">Medias livres</span><strong>${escapeHtml(health.freeMediumDoorCount ?? doors.filter((door) => door.size === 'M' && door.occupancy !== 'busy').length)}</strong></article>
      <article class="stat-card"><span class="muted">Grandes livres</span><strong>${escapeHtml(health.freeLargeDoorCount ?? doors.filter((door) => door.size === 'G' && door.occupancy !== 'busy').length)}</strong></article>
      <article class="stat-card"><span class="muted">Entregas ativas</span><strong>${activeDeliveries.length}</strong></article>
      <article class="stat-card"><span class="muted">Mais de 24h</span><strong>${escapeHtml(health.reminder24hCount ?? 0)}</strong></article>
      <article class="stat-card"><span class="muted">Mais de 48h</span><strong>${escapeHtml(health.reminder48hCount ?? 0)}</strong></article>
      <article class="stat-card"><span class="muted">Mais de 72h</span><strong>${escapeHtml(health.reminder72hCount ?? 0)}</strong></article>
      <article class="stat-card"><span class="muted">Comandos</span><strong>${pending.length}</strong></article>
      <article class="stat-card"><span class="muted">Sinal do armario</span><strong>${escapeHtml(formatAge(health.deviceAgeMs))}</strong></article>
    </div>
  `;
}

function renderOverview() {
  title.textContent = isSuperAdmin() ? 'Armario atual' : 'Resumo do locker';
  const health = runtime();
  root.innerHTML = `
    <div class="grid">
      ${renderStats()}
      <section class="panel health-panel ${isDeviceReady() ? '' : 'is-warning'}">
        <div class="panel-header">
          <div>
            <p class="eyebrow">Saude operacional</p>
            <h3>${isDeviceReady() ? 'Armario apto a receber comandos' : 'Atencao antes de abrir portas'}</h3>
          </div>
          <span class="tag">${escapeHtml(health.appVersion || 'v2')}</span>
        </div>
        <div class="health-grid">
          <div><span class="muted">Ultimo sinal</span><strong>${escapeHtml(formatAge(health.deviceAgeMs))}</strong></div>
          <div><span class="muted">Serial</span><strong>${state.data.device?.serialOpen ? 'OK' : 'Falha'}</strong></div>
          <div><span class="muted">SMTP</span><strong>${health.smtpConfigured ? 'Configurado' : 'Pendente'}</strong></div>
          <div><span class="muted">Fila</span><strong>${escapeHtml(health.pendingCommandCount ?? 0)}</strong></div>
          <div><span class="muted">Comissionamento</span><strong>${state.data.device?.commissioningStatus === 'complete' ? 'Concluido' : 'Pendente'}</strong></div>
        </div>
        ${renderSecurityWarnings()}
      </section>
      <div class="grid two">
        <section class="panel">
          <div class="panel-header">
            <div>
              <p class="eyebrow">Dispositivo</p>
              <h3>${escapeHtml(state.data.tenant?.lockerName || 'Locker')}</h3>
          </div>
          <span class="tag">${escapeHtml(state.data.device?.bridgeVersion || 'Bridge pendente')}</span>
        </div>
        <p class="muted">Serial: ${escapeHtml(state.data.device?.serialPath || 'aguardando status')}</p>
        <p class="muted">App do armario: ${escapeHtml(state.data.device?.edgeAppVersion || 'aguardando versao')}</p>
        <p class="muted">Acionamento: ${escapeHtml(state.data.device?.unlockTimeoutSeconds || '--')}s | Comissionamento: ${state.data.device?.commissioningStatus === 'complete' ? 'concluido' : 'pendente'}</p>
        <p class="muted">Ultimo sinal: ${escapeHtml(state.data.device?.lastSeenAt || 'sem leitura')}</p>
        <p class="muted">${escapeHtml(formatResidentSyncStatus())}</p>
      </section>
        <section class="panel">
          <div class="panel-header">
            <div>
              <p class="eyebrow">Acesso remoto</p>
              <h3>Abertura por fila segura</h3>
          </div>
        </div>
        <p class="muted">O sindico solicita a abertura aqui. O armario busca o comando, aciona a placa localmente e devolve o resultado.</p>
        <p class="muted">Regra atual: portas 1 e 2 sao grandes; todas as outras sao pequenas e usadas primeiro no deposito.</p>
      </section>
      </div>
      ${renderCommandTracker()}
    </div>
  `;
}

function renderPlatform() {
  title.textContent = 'Admin geral PREDDITA';
  const platform = state.data.platform || {};
  const lockers = platform.lockers || [];
  const failed = runtime().failedCommands || [];

  root.innerHTML = `
    <div class="grid">
      <section class="panel platform-hero">
        <div class="panel-header">
          <div>
            <p class="eyebrow">Operacao global</p>
            <h3>${escapeHtml(platform.onlineLockerCount ?? 0)} de ${escapeHtml(platform.lockerCount ?? 0)} armarios online</h3>
          </div>
          <span class="tag">PREDDITA</span>
        </div>
        <div class="health-grid">
          <div><span class="muted">Armarios</span><strong>${escapeHtml(platform.lockerCount ?? 0)}</strong></div>
          <div><span class="muted">Offline</span><strong>${escapeHtml(platform.offlineLockerCount ?? 0)}</strong></div>
          <div><span class="muted">Entregas ativas</span><strong>${escapeHtml(platform.activeDeliveryCount ?? 0)}</strong></div>
          <div><span class="muted">Comandos pendentes</span><strong>${escapeHtml(platform.pendingCommandCount ?? 0)}</strong></div>
          <div><span class="muted">Falhas</span><strong>${escapeHtml(platform.failedCommandCount ?? 0)}</strong></div>
        </div>
      </section>

      ${renderSecurityWarnings()}

      <section class="panel">
        <div class="panel-header">
          <div>
            <p class="eyebrow">Armarios monitorados</p>
            <h3>Todos os dispositivos conectados a esta API</h3>
          </div>
        </div>
        <div class="locker-list">
          ${lockers.map((locker) => `
            <article class="locker-card ${locker.online ? '' : 'is-offline'}">
              <div class="locker-top">
                <div>
                  <strong>${escapeHtml(locker.siteName)} · ${escapeHtml(locker.name)}</strong>
                  <p class="muted">${escapeHtml(locker.id)} | Board ${escapeHtml(locker.board)} | ${escapeHtml(locker.doorCount)} portas | App ${escapeHtml(locker.edgeAppVersion || '--')}</p>
                </div>
                <span class="tag">${locker.online ? 'Online' : 'Offline'}</span>
              </div>
              <div class="locker-metrics">
                <span>${escapeHtml(locker.freeDoorCount)} livres</span>
                <span>${escapeHtml(locker.freeSmallDoorCount ?? 0)} pequenas livres</span>
                <span>${escapeHtml(locker.freeMediumDoorCount ?? 0)} medias livres</span>
                <span>${escapeHtml(locker.freeLargeDoorCount ?? 0)} grandes livres</span>
                <span>${escapeHtml(locker.occupiedDoorCount)} ocupadas</span>
                <span>${escapeHtml(locker.activeDeliveryCount)} entregas</span>
                <span>Comissionamento ${locker.commissioningStatus === 'complete' ? 'concluido' : 'pendente'}</span>
                <span>${escapeHtml(formatAge(locker.deviceAgeMs))}</span>
              </div>
            </article>
          `).join('') || '<div class="empty">Nenhum armario cadastrado ainda.</div>'}
        </div>
      </section>

      <section class="panel">
        <div class="panel-header">
          <div>
            <p class="eyebrow">Fila e suporte</p>
            <h3>Falhas recentes de comando</h3>
          </div>
        </div>
        <div class="audit-list">
          ${failed.length ? failed.map((command) => `
            <article class="audit-card">
              <div class="audit-top">
                <strong>Porta ${escapeHtml(command.door)}</strong>
                <span class="small">${escapeHtml(command.completedAt || command.createdAt || '--')}</span>
              </div>
              <p class="muted">${escapeHtml(command.result?.error || command.reason || 'Comando falhou.')}</p>
            </article>
          `).join('') : '<div class="empty">Nenhuma falha recente.</div>'}
        </div>
      </section>
    </div>
  `;
}

function renderDoors() {
  title.textContent = 'Portas e abertura remota';
  const doors = state.data.doors || [];
  const ready = isDeviceReady();
  const smallFree = doors.filter((door) => door.size === 'P' && door.occupancy !== 'busy').length;
  const mediumFree = doors.filter((door) => door.size === 'M' && door.occupancy !== 'busy').length;
  const largeFree = doors.filter((door) => door.size === 'G' && door.occupancy !== 'busy').length;
  root.innerHTML = `
    ${ready ? '' : '<div class="message is-error">Armario sem confirmacao operacional recente. A abertura remota pode ficar pendente ate o dispositivo voltar a sincronizar.</div>'}
    ${renderCommandTracker()}
    <section class="door-summary panel">
      <div>
        <p class="eyebrow">Mapa fisico</p>
        <h3>Mapa configurado no comissionamento do locker</h3>
      </div>
      <div class="door-summary-metrics">
        <span>${escapeHtml(largeFree)} grandes livres</span>
        <span>${escapeHtml(mediumFree)} medias livres</span>
        <span>${escapeHtml(smallFree)} pequenas livres</span>
        <span>${escapeHtml(doors.filter((door) => door.occupancy === 'busy').length)} ocupadas</span>
      </div>
    </section>
    <div class="door-grid">
      ${doors.map((door) => `
        <article class="door-card ${door.status === 'open' ? 'is-open' : ''} ${door.occupancy === 'busy' ? 'is-busy' : ''} ${door.size === 'G' ? 'is-large-door' : door.size === 'M' ? 'is-medium-door' : 'is-small-door'}">
          <div class="door-top">
            <h3 class="door-title">Porta ${escapeHtml(door.channel)}</h3>
            <span class="tag">${escapeHtml(doorSizeLabel(door.size))}</span>
          </div>
          <p class="muted">${escapeHtml(doorSensorLabel(door.status))}</p>
          <p class="small">${door.occupancy === 'busy' ? `Ocupada${door.delivery?.unit ? ` por ${escapeHtml(door.delivery.unit)}` : ''}` : 'Livre'}</p>
          <div class="door-actions">
            <button class="primary-button" data-open-door="${escapeHtml(door.channel)}" ${ready ? '' : 'disabled'}>${escapeHtml(doorActionLabel(door))}</button>
          </div>
        </article>
      `).join('')}
    </div>
  `;
}

async function trackCommand(commandId) {
  state.trackingCommandId = commandId;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const payload = await api(`/api/admin/commands/${encodeURIComponent(commandId)}`);
    state.trackingCommand = payload.command;
    await refreshState({ skipCapture: true });
    state.trackingCommand = payload.command;
    render();
    if (payload.command.status === 'completed' || payload.command.status === 'failed') {
      showMessage(commandStatusLabel(payload.command), payload.command.status === 'failed');
      return payload.command;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 2500));
  }
  showMessage('Comando ainda em acompanhamento. Atualize novamente em alguns segundos.');
  return state.trackingCommand;
}

function residentFormHtml(resident = {}) {
  const template = document.querySelector('#resident-form-template');
  const node = template.content.cloneNode(true);
  const wrapper = document.createElement('div');
  wrapper.appendChild(node);
  const form = wrapper.querySelector('form');
  Object.entries(resident).forEach(([key, value]) => {
    if (form.elements[key]) form.elements[key].value = value ?? '';
  });
  return wrapper.innerHTML;
}

function renderResidents() {
  title.textContent = 'Cadastro de apartamentos';
  const residents = state.data.residents || [];
  root.innerHTML = `
    <div class="grid">
      <section class="panel">
        <div class="panel-header">
          <div>
            <p class="eyebrow">Novo cadastro</p>
            <h3>Adicionar apartamento</h3>
            <p class="muted">${escapeHtml(formatResidentSyncStatus())}</p>
          </div>
        </div>
        ${residentFormHtml(getResidentFormDraft())}
      </section>
      <section class="resident-list">
        ${residents.length ? residents.map((resident) => `
          <article class="resident-card">
            <div class="resident-top">
              <div>
                <h3>${escapeHtml(residentTitle(resident))}</h3>
                <p class="muted">${escapeHtml(unitLabel(resident))}</p>
              </div>
              <span class="tag">${resident.email ? 'E-mail OK' : 'Sem e-mail'}</span>
            </div>
            <p class="muted">${escapeHtml([resident.phone, resident.email].filter(Boolean).join(' | ') || 'Sem contato cadastrado')}</p>
            <div class="resident-actions">
              <button class="ghost-button" data-edit-resident="${escapeHtml(resident.id)}">Editar</button>
              <button class="danger-button" data-delete-resident="${escapeHtml(resident.id)}">Remover</button>
            </div>
            <div class="edit-slot" id="edit-${escapeHtml(resident.id)}">
              ${state.editingResidentId === resident.id ? residentFormHtml(getResidentFormDraft(resident)) : ''}
            </div>
          </article>
        `).join('') : '<div class="empty">Nenhum apartamento cadastrado.</div>'}
      </section>
    </div>
  `;
}

function renderDeliveries() {
  title.textContent = 'Entregas';
  const deliveries = state.data.deliveries || [];
  const activeDeliveries = deliveries.filter(isActiveDelivery);
  const health = runtime();
  const personalDataVisible = Boolean(session().canViewPersonalData);
  const withEvidence = deliveries.filter((delivery) => delivery.labelPhotoDataUrl || delivery.labelPhotoCapturedAt).length;
  root.innerHTML = `
    <section class="panel delivery-summary">
      <div>
        <p class="eyebrow">Operacao atual</p>
        <h3>${escapeHtml(activeDeliveries.length)} entregas ativas</h3>
        <p class="muted">${escapeHtml(withEvidence)} com foto da etiqueta | ${escapeHtml(health.pendingReminderCount ?? 0)} lembretes pendentes</p>
      </div>
      <div class="door-summary-metrics">
        <span>${escapeHtml(health.reminder24hCount ?? 0)} +24h</span>
        <span>${escapeHtml(health.reminder48hCount ?? 0)} +48h</span>
        <span>${escapeHtml(health.reminder72hCount ?? 0)} +72h</span>
      </div>
    </section>
    <section class="delivery-list">
      ${deliveries.length ? deliveries.map((delivery) => `
        <article class="delivery-card delivery-card--rich ${escapeHtml(deliveryAgeClass(delivery))}">
          <div class="delivery-evidence">
            ${delivery.labelPhotoDataUrl
              ? `<img src="${escapeHtml(delivery.labelPhotoDataUrl)}" alt="Foto da etiqueta da entrega" />`
              : `<div class="delivery-evidence-empty">${delivery.labelPhotoCapturedAt ? 'Foto protegida' : 'Sem foto'}</div>`}
          </div>
          <div class="delivery-card-main">
            <div class="delivery-top">
              <div>
                <h3>${escapeHtml(deliveryUnitLabel(delivery))}</h3>
                <p class="muted">Porta ${escapeHtml(delivery.door)} | ${escapeHtml(doorSizeLabel(delivery.doorSize || delivery.size))} | ${personalDataVisible ? `PIN ${escapeHtml(delivery.pin || '--')}` : 'Dados protegidos'}</p>
              </div>
              <span class="tag">${escapeHtml(deliveryStatusLabel(delivery.status))}</span>
            </div>
            <div class="delivery-meta-grid">
              <span>${escapeHtml(deliveryAgeLabel(delivery))}</span>
              <span>${escapeHtml(notificationLabel(delivery))}</span>
              <span>${escapeHtml(deliveryEvidenceLabel(delivery))}</span>
              <span>${escapeHtml(deliveryReminderLabel(delivery))}</span>
            </div>
            <div class="delivery-actions">
              ${isActiveDelivery(delivery) && delivery.status === 'stored' && delivery.pin && delivery.qrPayload
                ? `<button class="ghost-button" data-notify-delivery="${escapeHtml(delivery.id)}">Reenviar PIN e QR</button>`
                : '<span class="muted">Credenciais indisponiveis</span>'}
            </div>
          </div>
        </article>
      `).join('') : '<div class="empty">Nenhuma entrega sincronizada ainda.</div>'}
    </section>
  `;
}

function renderAudit() {
  title.textContent = 'Auditoria';
  const audit = state.data.auditTrail || [];
  root.innerHTML = `
    <section class="audit-list">
      ${audit.map((entry) => `
        <article class="audit-card">
          <div class="audit-top">
            <strong>${escapeHtml(entry.kind)}</strong>
            <span class="small">${escapeHtml(entry.at)}</span>
          </div>
          <p class="muted">${escapeHtml(entry.message)}</p>
        </article>
      `).join('')}
    </section>
  `;
}

function operationalLogLevelLabel(level) {
  return {
    debug: 'Debug',
    info: 'Info',
    warn: 'Alerta',
    error: 'Erro',
  }[level] || level || 'Info';
}

function operationalLogDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value || '--' : date.toLocaleString('pt-BR');
}

function renderLogs() {
  title.textContent = 'Logs operacionais';
  if (!session().canViewOperationalLogs) {
    root.innerHTML = '<section class="panel"><h3>Acesso restrito</h3><p class="muted">Esta area e reservada ao suporte PREDDITA.</p></section>';
    return;
  }
  const logState = state.operationalLogs;
  const filters = logState.filters;
  root.innerHTML = `
    <div class="operational-log-view">
      <form class="panel operational-log-filters" id="operational-log-filters">
        <div class="log-filter-grid">
          <label class="field">
            <span class="field-label">Severidade</span>
            <select class="text-input" name="level">
              <option value="">Todas</option>
              ${['debug', 'info', 'warn', 'error'].map((level) => `
                <option value="${level}" ${filters.level === level ? 'selected' : ''}>${operationalLogLevelLabel(level)}</option>
              `).join('')}
            </select>
          </label>
          <label class="field">
            <span class="field-label">Origem</span>
            <select class="text-input" name="source">
              <option value="">Todas</option>
              ${[
                ['server', 'Servidor'],
                ['admin', 'Painel'],
                ['device', 'Armario'],
                ['worker', 'Processos'],
              ].map(([value, label]) => `
                <option value="${value}" ${filters.source === value ? 'selected' : ''}>${label}</option>
              `).join('')}
            </select>
          </label>
          <label class="field">
            <span class="field-label">Evento</span>
            <input class="text-input" name="event" value="${escapeHtml(filters.event)}" placeholder="admin-login" />
          </label>
          <label class="field">
            <span class="field-label">Busca</span>
            <input class="text-input" name="query" value="${escapeHtml(filters.query)}" placeholder="Rota, mensagem ou requisicao" />
          </label>
        </div>
        <div class="log-filter-actions">
          <button class="primary-button" type="submit" ${logState.loading ? 'disabled' : ''}>Aplicar</button>
          <button class="ghost-button" type="button" data-clear-log-filters>Limpar</button>
          <button class="ghost-button" type="button" data-export="logs">Exportar CSV</button>
          <span class="small">Retencao: ${escapeHtml(logState.retentionDays)} dias</span>
        </div>
      </form>

      <section class="operational-log-list" aria-live="polite">
        ${logState.items.map((log) => `
          <article class="operational-log-row is-${escapeHtml(log.level)}">
            <div class="operational-log-time">
              <strong>${escapeHtml(operationalLogDate(log.occurredAt))}</strong>
              <span class="log-level">${escapeHtml(operationalLogLevelLabel(log.level))}</span>
            </div>
            <div class="operational-log-main">
              <div class="operational-log-heading">
                <strong>${escapeHtml(log.event)}</strong>
                <span class="small">${escapeHtml(log.source)}${log.actor ? ` · ${escapeHtml(log.actor)}` : ''}</span>
              </div>
              <p>${escapeHtml(log.message || '--')}</p>
              <div class="operational-log-meta">
                ${log.httpPath ? `<code>${escapeHtml(`${log.httpMethod || ''} ${log.httpPath}`.trim())}</code>` : ''}
                ${log.statusCode ? `<span>HTTP ${escapeHtml(log.statusCode)}</span>` : ''}
                ${Number.isFinite(log.durationMs) ? `<span>${escapeHtml(log.durationMs)} ms</span>` : ''}
                ${log.requestId ? `<span>${escapeHtml(log.requestId)}</span>` : ''}
              </div>
              ${Object.keys(log.context || {}).length ? `
                <details class="operational-log-context">
                  <summary>Contexto</summary>
                  <pre>${escapeHtml(JSON.stringify(log.context, null, 2))}</pre>
                </details>
              ` : ''}
            </div>
          </article>
        `).join('') || (logState.loading
          ? '<div class="empty">Carregando registros...</div>'
          : '<div class="empty">Nenhum registro encontrado.</div>')}
      </section>

      ${logState.nextCursor ? `
        <div class="log-pagination">
          <button class="ghost-button" data-load-more-logs ${logState.loading ? 'disabled' : ''}>
            ${logState.loading ? 'Carregando...' : 'Carregar mais antigos'}
          </button>
        </div>
      ` : ''}
    </div>
  `;
}

function renderSystem() {
  title.textContent = 'Sistema';
  if (!session().canViewSecurity) {
    root.innerHTML = '<section class="panel"><h3>Acesso restrito</h3><p class="muted">Esta area e reservada ao Admin Geral PREDDITA.</p></section>';
    return;
  }
  const commandWakeupConnected = Boolean(runtime().deviceCommandWakeupConnected);
  const commandTransport = runtime().iotConfigured ? 'AWS IoT Core' : 'Polling HTTP';
  const commandWakeupState = runtime().deviceCommandWakeupState || 'disabled';
  root.innerHTML = `
    <div class="grid two">
      <section class="panel">
        <p class="eyebrow">Configuracao atual</p>
        <h3>${escapeHtml(state.data.tenant?.lockerId)}</h3>
        <p class="muted">Board ${escapeHtml(state.data.device?.board)} | ${escapeHtml(state.data.device?.doorCount)} portas</p>
      </section>
      <section class="panel">
        <p class="eyebrow">Seguranca</p>
        <h3>Sessoes administrativas</h3>
        <p class="muted">Usuarios usam senha derivada por scrypt, cookie HttpOnly e protecao CSRF.</p>
      </section>
      <section class="panel ${runtime().iotConfigured && !commandWakeupConnected ? 'is-warning' : ''}">
        <div class="panel-header">
          <div>
            <p class="eyebrow">Entrega de comandos</p>
            <h3>${escapeHtml(commandTransport)}</h3>
          </div>
          <span class="tag">${commandWakeupConnected ? 'MQTT conectado' : 'Contingencia ativa'}</span>
        </div>
        <div class="health-grid">
          <div><span class="muted">Backend</span><strong>${runtime().iotConfigured ? 'Configurado' : 'Desativado'}</strong></div>
          <div><span class="muted">Armario</span><strong>${escapeHtml(commandWakeupState)}</strong></div>
          <div><span class="muted">Ultima conexao</span><strong>${escapeHtml(runtime().deviceCommandWakeupLastConnectedAt || '--')}</strong></div>
          <div><span class="muted">Ultimo aviso</span><strong>${escapeHtml(runtime().deviceCommandWakeupLastMessageAt || '--')}</strong></div>
        </div>
        <p class="muted">O polling HTTP permanece ativo como contingencia para comandos e sincronizacoes.</p>
      </section>
      ${session().canExportData ? `<section class="panel">
        <p class="eyebrow">Exportacao</p>
        <h3>Relatorios CSV</h3>
        <p class="muted">Baixe dados operacionais para auditoria, suporte ou conferencia do sindico.</p>
        <div class="export-actions">
          <button class="ghost-button" data-export="residents">Apartamentos</button>
          <button class="ghost-button" data-export="deliveries">Entregas</button>
          <button class="ghost-button" data-export="audit">Auditoria</button>
        </div>
      </section>` : ''}
    </div>
  `;
}

function renderPrivacy() {
  title.textContent = 'Privacidade e retencao';
  if (!session().canManagePrivacy) {
    root.innerHTML = '<section class="panel"><h3>Acesso restrito</h3><p class="muted">Esta area exige permissao de privacidade.</p></section>';
    return;
  }
  const summary = state.privacy.summary;
  if (!summary) {
    root.innerHTML = `<section class="panel"><h3>${state.privacy.loading ? 'Carregando politica...' : 'Politica indisponivel'}</h3></section>`;
    return;
  }
  const policy = summary.policy || {};
  const metrics = summary.metrics || {};
  const pending = Number(metrics.terminalCredentialsPending || 0)
    + Number(metrics.personalDataPastRetention || 0)
    + Number(metrics.evidencePastRetention || 0)
    + Number(metrics.deliveryRecordsPastRetention || 0)
    + Number(metrics.auditEntriesPastRetention || 0)
    + Number(metrics.commandsPastRetention || 0)
    + Number(metrics.notificationsPastRetention || 0)
    + Number(metrics.processedEventsPastRetention || 0);
  const residents = state.data.residents || [];
  root.innerHTML = `
    <div class="grid">
      <div class="grid stats">
        <article class="stat-card"><span class="muted">Apartamentos</span><strong>${escapeHtml(metrics.residentCount ?? 0)}</strong></article>
        <article class="stat-card"><span class="muted">Entregas ativas</span><strong>${escapeHtml(metrics.activeDeliveryCount ?? 0)}</strong></article>
        <article class="stat-card"><span class="muted">Historico anonimizado</span><strong>${escapeHtml(metrics.anonymizedDeliveryCount ?? 0)}</strong></article>
        <article class="stat-card"><span class="muted">Itens vencidos</span><strong>${escapeHtml(pending)}</strong></article>
      </div>
      <section class="panel ${pending ? 'is-warning' : ''}">
        <div class="panel-header">
          <div>
            <p class="eyebrow">Politica ativa</p>
            <h3>${pending ? `${escapeHtml(pending)} itens aguardando limpeza` : 'Retencao em dia'}</h3>
          </div>
          <button class="primary-button" type="button" data-run-privacy-retention ${state.privacy.loading ? 'disabled' : ''}>Executar agora</button>
        </div>
        <div class="health-grid">
          <div><span class="muted">Controlador</span><strong>${escapeHtml(policy.controllerName || 'Nao configurado')}</strong></div>
          <div class="privacy-contact"><span class="muted">Contato LGPD</span><strong>${escapeHtml(policy.contactEmail || 'Nao configurado')}</strong></div>
          <div><span class="muted">Ultima execucao</span><strong>${escapeHtml(summary.lastAppliedAt || 'Sem alteracoes ainda')}</strong></div>
          <div><span class="muted">Credenciais encerradas</span><strong>Imediata</strong></div>
        </div>
      </section>
      <section class="panel">
        <div class="panel-header">
          <div>
            <p class="eyebrow">Prazos configurados</p>
            <h3>Ciclo de vida</h3>
          </div>
          <span class="tag">Politica ${escapeHtml(policy.schemaVersion || 1)}</span>
        </div>
        <div class="health-grid">
          <div><span class="muted">Fotos e OCR</span><strong>${escapeHtml(policy.deliveryEvidenceRetentionDays)} dias</strong></div>
          <div><span class="muted">Dados de entregas</span><strong>${escapeHtml(policy.deliveryPersonalDataRetentionDays)} dias</strong></div>
          <div><span class="muted">Historico anonimizado</span><strong>${escapeHtml(policy.deliveryRecordRetentionDays)} dias</strong></div>
          <div><span class="muted">Auditoria</span><strong>${escapeHtml(policy.auditRetentionDays)} dias</strong></div>
          <div><span class="muted">Comandos</span><strong>${escapeHtml(policy.commandRetentionDays)} dias</strong></div>
          <div><span class="muted">Notificacoes</span><strong>${escapeHtml(policy.notificationRetentionDays)} dias</strong></div>
          <div><span class="muted">Eventos idempotentes</span><strong>${escapeHtml(policy.processedEventRetentionDays)} dias</strong></div>
          <div><span class="muted">Backups locais</span><strong>${escapeHtml(policy.backupRetentionDays)} dias</strong></div>
          <div><span class="muted">Logs tecnicos</span><strong>${escapeHtml(policy.operationalLogRetentionDays)} dias</strong></div>
        </div>
      </section>
      <section class="resident-list">
        ${residents.length ? residents.map((resident) => `
          <article class="resident-card">
            <div class="resident-top">
              <div>
                <h3>${escapeHtml(residentTitle(resident))}</h3>
                <p class="muted">${escapeHtml(unitLabel(resident))}</p>
              </div>
              <span class="tag">Titular</span>
            </div>
            <div class="resident-actions">
              <button class="ghost-button" type="button" data-export-resident-data="${escapeHtml(resident.id)}">Exportar dados</button>
              <button class="danger-button" type="button" data-delete-resident="${escapeHtml(resident.id)}">Eliminar cadastro</button>
            </div>
          </article>
        `).join('') : '<div class="empty">Nenhum apartamento cadastrado.</div>'}
      </section>
    </div>
  `;
}

function renderUpdates() {
  title.textContent = 'Atualizacoes do app';
  if (!session().canManageUpdates) {
    root.innerHTML = '<section class="panel"><h3>Acesso restrito</h3><p class="muted">Esta area e reservada ao suporte PREDDITA.</p></section>';
    return;
  }
  const policy = state.data.appUpdate || {};
  const updater = state.data.device?.appUpdater || {};
  const status = updater.status || 'unknown';
  const health = updater.health || {};
  const healthSignals = [
    health.appStarted,
    health.webViewReady,
    health.edgeAgentReady,
    health.stateLoaded,
    health.configurationBackupChecked && health.configurationBackupValid,
    health.credentialAvailable,
    health.serialClassified,
  ];
  const readyHealthSignals = healthSignals.filter(Boolean).length;
  const healthSummary = policy.healthSummary || {};
  const updateWarning = ['failed', 'degraded', 'failed-health'].includes(status);
  root.innerHTML = `
    <div class="grid">
      <div class="grid stats">
        <article class="stat-card"><span class="muted">App instalado</span><strong>${escapeHtml(updater.currentVersionName || state.data.device?.edgeAppVersion || '--')}</strong></article>
        <article class="stat-card"><span class="muted">Version code</span><strong>${escapeHtml(updater.currentVersionCode || '--')}</strong></article>
        <article class="stat-card"><span class="muted">Atualizador</span><strong>${escapeHtml(appUpdateStatusLabel(status))}</strong></article>
        <article class="stat-card"><span class="muted">Progresso</span><strong>${escapeHtml(updater.progressPercentage || 0)}%</strong></article>
      </div>

      <section class="panel update-status-panel ${updateWarning ? 'is-warning' : ''}">
        <div class="panel-header">
          <div>
            <p class="eyebrow">Telemetria do dispositivo</p>
            <h3>${escapeHtml(appUpdateStatusLabel(status))}</h3>
          </div>
          <span class="tag">${updater.available ? 'Nativo disponivel' : 'Aguardando app'}</span>
        </div>
        <div class="health-grid">
          <div><span class="muted">Release</span><strong>${escapeHtml(updater.releaseId || '--')}</strong></div>
          <div><span class="muted">Destino</span><strong>${escapeHtml(updater.targetVersionName || '--')}</strong></div>
          <div><span class="muted">Atualizado em</span><strong>${escapeHtml(updater.updatedAt || '--')}</strong></div>
          <div><span class="muted">Ultimo erro</span><strong>${escapeHtml(updater.lastError || 'Nenhum')}</strong></div>
          <div><span class="muted">Sinais de saude</span><strong>${escapeHtml(readyHealthSignals)}/7 prontos</strong></div>
          <div><span class="muted">Health check</span><strong>${escapeHtml(health.checkedAt || 'Ainda nao concluido')}</strong></div>
          <div><span class="muted">Causa</span><strong>${escapeHtml(updater.healthFailureCode || health.serialErrorCode || 'Nenhuma')}</strong></div>
          <div><span class="muted">Prazo</span><strong>${escapeHtml(health.deadlineAt || '--')}</strong></div>
        </div>
        ${updater.recommendedAction ? `<p class="panel-note"><strong>Acao recomendada:</strong> ${escapeHtml(updater.recommendedAction)}</p>` : ''}
      </section>

      <section class="panel ${policy.autoPausedAt ? 'is-warning' : ''}">
        <div class="panel-header">
          <div>
            <p class="eyebrow">Protecao do rollout</p>
            <h3>${policy.autoPausedAt ? 'Rollout pausado automaticamente' : 'Monitoramento ativo'}</h3>
          </div>
          <span class="tag">${escapeHtml(healthSummary.sampleCount || 0)} amostra(s)</span>
        </div>
        <div class="health-grid">
          <div><span class="muted">Saudaveis</span><strong>${escapeHtml(healthSummary.healthyCount || 0)}</strong></div>
          <div><span class="muted">Degradados</span><strong>${escapeHtml(healthSummary.degradedCount || 0)}</strong></div>
          <div><span class="muted">Falhas</span><strong>${escapeHtml(healthSummary.failureCount || 0)}</strong></div>
          <div><span class="muted">Taxa de falha</span><strong>${escapeHtml(healthSummary.failurePercentage || 0)}%</strong></div>
        </div>
        ${policy.autoPauseReason ? `<p class="panel-note">${escapeHtml(policy.autoPauseReason)}</p>` : ''}
      </section>

      <form class="panel update-policy-form" id="update-policy-form">
        <div class="panel-header">
          <div>
            <p class="eyebrow">Distribuicao controlada</p>
            <h3>Publicar APK assinado</h3>
          </div>
          <span class="tag">${policy.enabled ? 'Ativa' : 'Pausada'}</span>
        </div>

        <div class="update-toggle-grid">
          <label class="toggle-row">
            <input type="checkbox" name="enabled" ${policy.enabled ? 'checked' : ''}>
            <span>Distribuicao ativa</span>
          </label>
          <label class="toggle-row">
            <input type="checkbox" name="automaticPauseEnabled" ${policy.automaticPauseEnabled !== false ? 'checked' : ''}>
            <span>Pausa automatica por falha</span>
          </label>
        </div>

        <div class="form-grid update-form-grid">
          <label>Canal
            <select name="channel" required>
              <option value="lab" ${policy.channel === 'lab' ? 'selected' : ''}>Laboratorio</option>
              <option value="pilot" ${policy.channel === 'pilot' ? 'selected' : ''}>Piloto</option>
              <option value="production" ${policy.channel === 'production' ? 'selected' : ''}>Producao</option>
            </select>
          </label>
          <label>Rollout (%)
            <input name="rolloutPercentage" type="number" min="0" max="100" step="1" value="${escapeHtml(policy.rolloutPercentage ?? 0)}" required>
          </label>
          <label>Limite de falha (%)
            <input name="failureThresholdPercentage" type="number" min="1" max="100" step="1" value="${escapeHtml(policy.failureThresholdPercentage ?? 25)}" required>
          </label>
          <label>Release
            <input name="releaseId" maxlength="120" value="${escapeHtml(policy.releaseId || '')}" placeholder="v2.0.33-lab">
          </label>
          <label>Version code
            <input name="versionCode" type="number" min="1" max="2147483647" step="1" value="${escapeHtml(policy.versionCode || '')}" placeholder="31">
          </label>
          <label>Version name
            <input name="versionName" maxlength="80" value="${escapeHtml(policy.versionName || '')}" placeholder="2.0.33-lab">
          </label>
          <label class="update-field-wide">URL HTTPS do APK
            <input name="apkUrl" type="url" maxlength="2048" value="${escapeHtml(policy.apkUrl || '')}" placeholder="https://github.com/.../PREDDITA-Locker.apk">
          </label>
          <label class="update-field-full">SHA-256
            <input class="monospace-input" name="sha256" minlength="64" maxlength="64" value="${escapeHtml(policy.sha256 || '')}" placeholder="64 caracteres hexadecimais">
          </label>
          <label class="update-field-full">Notas da versao
            <textarea name="notes" maxlength="500" rows="4" placeholder="Mudancas operacionais desta versao">${escapeHtml(policy.notes || '')}</textarea>
          </label>
        </div>
        <div class="form-actions">
          <p class="muted">O APK so sera instalado quando o locker estiver ocioso e passar por todas as verificacoes nativas.</p>
          <button class="primary-button" type="submit">Salvar distribuicao</button>
        </div>
      </form>
    </div>
  `;
}

function renderPilot() {
  title.textContent = 'Piloto controlado';
  const summary = runtime().pilotSummary || {};
  const metrics = state.data.pilot?.metrics || [];
  const policy = state.data.appUpdate || {};
  const updater = state.data.device?.appUpdater || {};
  const candidateVersion = runtime().appVersion || '';
  const installedVersion = updater.currentVersionName || state.data.device?.edgeAppVersion || '';
  const readiness = [
    ['Sinal recente do locker', isDeviceReady()],
    ['Serial RS-485 aberta', Boolean(state.data.device?.serialOpen)],
    ['Comissionamento concluido', state.data.device?.commissioningStatus === 'complete'],
    ['Autenticacao do dispositivo em HMAC', runtime().deviceAuthMode === 'hmac'],
    ['Credencial HMAC provisionada', updater.health?.credentialAvailable === true],
    ['Versao candidata instalada', Boolean(candidateVersion) && installedVersion === candidateVersion],
    ['Atualizador sem falha ativa', ['idle', 'up-to-date', 'healthy'].includes(updater.status)],
    ['Canal sem distribuicao ampla', !policy.enabled || (policy.channel !== 'production' && Number(policy.rolloutPercentage || 0) <= 10)],
    ['Rollout sem pausa automatica', !policy.autoPausedAt],
    ['Mapa de portas recebido', Array.isArray(state.data.doors) && state.data.doors.length > 0 && state.data.doors.length === Number(state.data.device?.doorCount || state.data.doors.length)],
  ];
  const readyCount = readiness.filter(([, ready]) => ready).length;
  const blocked = readyCount !== readiness.length;

  root.innerHTML = `
    <div class="grid">
      <div class="grid stats">
        <article class="stat-card"><span class="muted">Jornadas</span><strong>${escapeHtml(summary.sampleCount || 0)}</strong></article>
        <article class="stat-card"><span class="muted">Conclusao</span><strong>${escapeHtml(summary.completionPercentage || 0)}%</strong></article>
        <article class="stat-card"><span class="muted">Mediana</span><strong>${escapeHtml(formatPilotDuration(summary.medianDurationMs))}</strong></article>
        <article class="stat-card"><span class="muted">P95</span><strong>${escapeHtml(formatPilotDuration(summary.p95DurationMs))}</strong></article>
      </div>

      <section class="panel pilot-readiness ${blocked ? 'is-warning' : ''}">
        <div class="panel-header">
          <div>
            <p class="eyebrow">Preflight operacional</p>
            <h3>${blocked ? 'Piloto bloqueado por pendencias' : 'Software pronto para o piloto'}</h3>
          </div>
          <span class="tag">${escapeHtml(readyCount)}/${escapeHtml(readiness.length)} prontos</span>
        </div>
        <div class="pilot-check-grid">
          ${readiness.map(([label, ready]) => `
            <div class="pilot-check ${ready ? 'is-ready' : 'is-blocked'}">
              <span aria-hidden="true">${ready ? '&#10003;' : '!'}</span>
              <strong>${escapeHtml(label)}</strong>
            </div>
          `).join('')}
        </div>
        <p class="panel-note">A validacao fisica do KS1062, o APK assinado e a autorizacao do local continuam obrigatorios antes de liberar usuarios reais.</p>
      </section>

      <div class="grid two">
        <section class="panel">
          <div class="panel-header">
            <div>
              <p class="eyebrow">Resultado das jornadas</p>
              <h3>Entrega e retirada</h3>
            </div>
          </div>
          <div class="health-grid">
            <div><span class="muted">Entregas</span><strong>${escapeHtml(summary.courierCount || 0)}</strong></div>
            <div><span class="muted">Retiradas</span><strong>${escapeHtml(summary.pickupCount || 0)}</strong></div>
            <div><span class="muted">PIN</span><strong>${escapeHtml(summary.pinPickupCount || 0)}</strong></div>
            <div><span class="muted">QR</span><strong>${escapeHtml(summary.qrPickupCount || 0)}</strong></div>
            <div><span class="muted">Canceladas</span><strong>${escapeHtml(summary.cancelledCount || 0)}</strong></div>
            <div><span class="muted">Interrompidas</span><strong>${escapeHtml(summary.interruptedCount || 0)}</strong></div>
          </div>
        </section>
        <section class="panel">
          <div class="panel-header">
            <div>
              <p class="eyebrow">Friccao observada</p>
              <h3>Ajuda, fallback e erros</h3>
            </div>
          </div>
          <div class="health-grid">
            <div><span class="muted">Pedidos de ajuda</span><strong>${escapeHtml(summary.helpRequestCount || 0)}</strong></div>
            <div><span class="muted">Taxa de ajuda</span><strong>${escapeHtml(summary.helpRequestPercentage || 0)}%</strong></div>
            <div><span class="muted">Fallback de tamanho</span><strong>${escapeHtml(summary.fallbackCount || 0)}</strong></div>
            <div><span class="muted">Taxa de fallback</span><strong>${escapeHtml(summary.fallbackPercentage || 0)}%</strong></div>
            <div><span class="muted">Erros sinalizados</span><strong>${escapeHtml(summary.errorCount || 0)}</strong></div>
            <div><span class="muted">Falhas finais</span><strong>${escapeHtml(summary.failedCount || 0)}</strong></div>
          </div>
        </section>
        <section class="panel">
          <div class="panel-header">
            <div>
              <p class="eyebrow">Entrega inteligente</p>
              <h3>Analise e alocacao</h3>
            </div>
            <span class="tag">${escapeHtml(summary.retentionDays || 30)} dias</span>
          </div>
          <div class="health-grid">
            <div><span class="muted">Tentativas</span><strong>${escapeHtml(summary.smartCourierCount || 0)}</strong></div>
            <div><span class="muted">Modo manual</span><strong>${escapeHtml(summary.manualCourierCount || 0)}</strong></div>
            <div><span class="muted">Recomendacao P</span><strong>${escapeHtml(summary.smartReadyPCount || 0)}</strong></div>
            <div><span class="muted">Recomendacao G</span><strong>${escapeHtml(summary.smartReadyGCount || 0)}</strong></div>
            <div><span class="muted">Inconclusivas</span><strong>${escapeHtml((summary.smartUncertainCount || 0) + (summary.smartFailedCount || 0))}</strong></div>
            <div><span class="muted">Confirmadas</span><strong>${escapeHtml(summary.smartRecommendationConfirmedCount || 0)}</strong></div>
            <div><span class="muted">Portas abertas</span><strong>${escapeHtml(summary.smartDoorOpenedCount || 0)}</strong></div>
            <div><span class="muted">Indisponiveis/falhas</span><strong>${escapeHtml((summary.smartDoorUnavailableCount || 0) + (summary.smartDoorFailedCount || 0))}</strong></div>
          </div>
          <p class="panel-note">Somente resultados tecnicos sanitizados; imagens, unidade, PIN, QR, porta e textos livres nao sao enviados.</p>
        </section>
      </div>

      <section class="panel">
        <div class="panel-header">
          <div>
            <p class="eyebrow">Amostras sanitizadas</p>
            <h3>Jornadas recentes</h3>
          </div>
          <span class="tag">Sem apartamento, PIN, QR ou porta</span>
        </div>
        <div class="pilot-metric-list">
          ${metrics.slice(0, 12).map((metric) => `
            <article class="pilot-metric-row">
              <div>
                <strong>${escapeHtml(pilotJourneyLabel(metric.journeyType))}</strong>
                <span>${escapeHtml(pilotOutcomeLabel(metric.outcome))}</span>
              </div>
              <div><span>Duracao</span><strong>${escapeHtml(formatPilotDuration(metric.durationMs))}</strong></div>
              <div><span>Modo</span><strong>${escapeHtml(metric.journeyType === 'courier'
                ? metric.deliveryMode === 'smart' ? 'INTELIGENTE' : metric.deliveryMode === 'manual' ? 'MANUAL' : '--'
                : metric.pickupMode === 'none' ? '--' : metric.pickupMode.toUpperCase())}</strong></div>
              <div><span>Ajuda</span><strong>${metric.helpRequested ? 'Sim' : 'Nao'}</strong></div>
              <div><span>Erros</span><strong>${escapeHtml(metric.errorCount || 0)}</strong></div>
            </article>
          `).join('') || '<div class="empty">As metricas aparecem depois das primeiras jornadas no locker.</div>'}
        </div>
      </section>
    </div>
  `;
}

function render() {
  if (!state.data) return;
  updateChrome();
  if (state.view === 'platform') renderPlatform();
  if (state.view === 'overview') renderOverview();
  if (state.view === 'doors') renderDoors();
  if (state.view === 'residents') renderResidents();
  if (state.view === 'deliveries') renderDeliveries();
  if (state.view === 'audit') renderAudit();
  if (state.view === 'pilot') renderPilot();
  if (state.view === 'logs') renderLogs();
  if (state.view === 'updates') renderUpdates();
  if (state.view === 'privacy') renderPrivacy();
  if (state.view === 'system') renderSystem();
}

async function saveResident(form) {
  storeResidentDraft(form);
  const body = Object.fromEntries(new FormData(form).entries());
  const id = body.id;
  delete body.id;
  if (id) {
    await api(`/api/admin/residents/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    showMessage('Apartamento atualizado. O armario sincroniza automaticamente em alguns segundos.');
    delete state.residentDrafts.edit[id];
    state.editingResidentId = '';
  } else {
    await api('/api/admin/residents', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    showMessage('Apartamento cadastrado. O armario sincroniza automaticamente em alguns segundos.');
    state.residentDrafts.new = {};
  }
  await loadState({ skipCapture: true });
}

document.addEventListener('click', async (event) => {
  const nav = event.target.closest('[data-view]');
  if (nav) {
    setView(nav.dataset.view);
    return;
  }

  if (event.target.id === 'logout-button') {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    showLogin();
    return;
  }

  if (event.target.id === 'refresh-button') {
    await refreshState().catch((error) => showMessage(error.message, true));
    if (state.view === 'privacy') {
      await loadPrivacySummary().catch((error) => showMessage(error.message, true));
    }
    return;
  }

  const privacyRunButton = event.target.closest('[data-run-privacy-retention]');
  if (privacyRunButton) {
    privacyRunButton.disabled = true;
    const payload = await api('/api/admin/privacy/retention/run', {
      method: 'POST',
      body: JSON.stringify({}),
    }).catch((error) => {
      showMessage(error.message, true);
      return null;
    });
    if (!payload) return;
    state.privacy.summary = payload.privacy;
    const changed = Object.values(payload.result || {}).reduce((total, value) => total + Number(value || 0), 0);
    showMessage(changed ? `${changed} itens de dados foram tratados pela politica.` : 'A politica foi executada e a retencao esta em dia.');
    await loadState({ skipCapture: true });
    await loadPrivacySummary();
    return;
  }

  const residentDataExport = event.target.closest('[data-export-resident-data]');
  if (residentDataExport) {
    const residentId = residentDataExport.dataset.exportResidentData;
    await downloadAdminFile(
      `/api/admin/privacy/residents/${encodeURIComponent(residentId)}/export`,
      `preddita-dados-${residentId}.json`
    ).catch((error) => showMessage(error.message, true));
    return;
  }

  const exportButton = event.target.closest('[data-export]');
  if (exportButton) {
    const kind = exportButton.dataset.export;
    const map = {
      residents: ['/api/admin/export/residents.csv', 'preddita-apartamentos.csv'],
      deliveries: ['/api/admin/export/deliveries.csv', 'preddita-entregas.csv'],
      audit: ['/api/admin/export/audit.csv', 'preddita-auditoria.csv'],
      logs: [`/api/admin/export/logs.csv?${operationalLogQuery()}`, 'preddita-logs-operacionais.csv'],
    };
    const target = map[kind];
    if (!target) return;
    await downloadAdminFile(target[0], target[1]).catch((error) => showMessage(error.message, true));
    return;
  }

  if (event.target.closest('[data-clear-log-filters]')) {
    state.operationalLogs.filters = { level: '', source: '', event: '', query: '' };
    state.operationalLogs.loaded = false;
    await loadOperationalLogs().catch((error) => showMessage(error.message, true));
    return;
  }

  if (event.target.closest('[data-load-more-logs]')) {
    await loadOperationalLogs({ append: true }).catch((error) => showMessage(error.message, true));
    return;
  }

  const doorButton = event.target.closest('[data-open-door]');
  if (doorButton) {
    const door = doorButton.dataset.openDoor;
    const doorData = (state.data.doors || []).find((item) => String(item.channel) === String(door));
    const reason = window.prompt(
      doorData?.occupancy === 'busy'
        ? `Motivo para abrir e liberar a porta ocupada ${door}:`
        : `Motivo para abrir a porta ${door}:`,
      isSuperAdmin() ? 'Abertura remota pelo Admin Geral PREDDITA.' : 'Abertura remota pelo sindico.'
    );
    if (reason === null) return;
    const payload = await api(`/api/admin/doors/${door}/open`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
    state.trackingCommand = payload.command;
    showMessage(`Comando criado para a porta ${door}. Acompanhando confirmacao do armario.`);
    await loadState({ skipCapture: true });
    trackCommand(payload.command.id).catch((error) => showMessage(error.message, true));
    return;
  }

  const notifyButton = event.target.closest('[data-notify-delivery]');
  if (notifyButton) {
    const deliveryId = notifyButton.dataset.notifyDelivery;
    notifyButton.disabled = true;
    await api(`/api/admin/deliveries/${encodeURIComponent(deliveryId)}/notify`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    showMessage('Reenvio solicitado. O status da entrega foi atualizado.');
    await loadState({ skipCapture: true });
    return;
  }

  const editButton = event.target.closest('[data-edit-resident]');
  if (editButton) {
    const resident = (state.data.residents || []).find((item) => item.id === editButton.dataset.editResident);
    state.editingResidentId = editButton.dataset.editResident;
    state.residentDrafts.edit[state.editingResidentId] = {
      ...resident,
      ...(state.residentDrafts.edit[state.editingResidentId] || {}),
    };
    renderResidents();
    return;
  }

  const deleteButton = event.target.closest('[data-delete-resident]');
  if (deleteButton) {
    const confirmation = state.view === 'privacy'
      ? 'Eliminar este cadastro e anonimizar o historico encerrado associado? Esta acao nao pode ser desfeita.'
      : 'Remover este apartamento e anonimizar o historico encerrado associado?';
    if (!window.confirm(confirmation)) return;
    const payload = await api(`/api/admin/residents/${encodeURIComponent(deleteButton.dataset.deleteResident)}`, { method: 'DELETE' });
    const historyCount = Number(payload.anonymizedDeliveryCount || 0);
    showMessage(historyCount
      ? `Cadastro eliminado e ${historyCount} entrega(s) encerrada(s) anonimizada(s).`
      : 'Cadastro eliminado. O armario sincroniza automaticamente em alguns segundos.');
    await loadState({ skipCapture: true });
    if (state.view === 'privacy') await loadPrivacySummary();
    return;
  }

  if (event.target.closest('[data-cancel-form]')) {
    const form = event.target.closest('.resident-form');
    const id = form?.elements.id?.value;
    if (id) {
      delete state.residentDrafts.edit[id];
      state.editingResidentId = '';
    } else {
      state.residentDrafts.new = {};
    }
    await refreshState({ skipCapture: true });
  }
});

document.addEventListener('input', (event) => {
  const form = event.target.closest('.resident-form');
  if (!form) return;
  storeResidentDraft(form);
});

document.addEventListener('submit', async (event) => {
  if (event.target === loginForm) {
    event.preventDefault();
    loginButton.disabled = true;
    loginMessage.hidden = true;
    const { response, payload } = await authRequest('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        username: loginUsername.value.trim(),
        password: loginPassword.value,
      }),
    }).catch(() => ({ response: null, payload: {} }));
    loginButton.disabled = false;
    if (!response?.ok) {
      showLogin(payload.error || 'Nao foi possivel entrar.');
      return;
    }
    loginPassword.value = '';
    if (payload.mfa?.required && payload.mfa.challengeToken) {
      showMfa(payload.mfa);
      return;
    }
    if (!payload.session?.csrfToken) {
      showLogin('A resposta de autenticacao esta incompleta.');
      return;
    }
    acceptAuthenticatedSession(payload);
    showAdmin();
    await loadState().catch((error) => {
      showMessage(error.message, true);
    });
    return;
  }
  if (event.target === mfaForm) {
    event.preventDefault();
    const recoveryMode = Boolean(state.mfa?.recoveryMode);
    mfaButton.disabled = true;
    mfaMessage.hidden = true;
    const { response, payload } = await authRequest('/api/auth/mfa/verify', {
      method: 'POST',
      body: JSON.stringify({
        challengeToken: state.mfa?.challengeToken,
        ...(recoveryMode
          ? { recoveryCode: mfaRecoveryCode.value.trim() }
          : { code: mfaCode.value.trim() }),
      }),
    }).catch(() => ({ response: null, payload: {} }));
    mfaButton.disabled = false;
    if (!response?.ok || !payload.session?.csrfToken) {
      mfaMessage.textContent = payload.error || 'Nao foi possivel confirmar o codigo.';
      mfaMessage.hidden = false;
      return;
    }
    acceptAuthenticatedSession(payload);
    const recoveryCodes = payload.mfa?.recoveryCodes || [];
    if (recoveryCodes.length > 0) {
      showRecoveryCodes(recoveryCodes);
      return;
    }
    showAdmin();
    await loadState().catch((error) => showMessage(error.message, true));
    return;
  }
  if (event.target.id === 'operational-log-filters') {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.target).entries());
    state.operationalLogs.filters = {
      level: String(values.level || ''),
      source: String(values.source || ''),
      event: String(values.event || '').trim(),
      query: String(values.query || '').trim(),
    };
    state.operationalLogs.loaded = false;
    await loadOperationalLogs().catch((error) => showMessage(error.message, true));
    return;
  }
  if (event.target.id === 'update-policy-form') {
    event.preventDefault();
    const form = event.target;
    const values = Object.fromEntries(new FormData(form).entries());
    try {
      await api('/api/admin/update-policy', {
        method: 'PUT',
        body: JSON.stringify({
          ...values,
          enabled: form.elements.enabled.checked,
          automaticPauseEnabled: form.elements.automaticPauseEnabled.checked,
          rolloutPercentage: Number(values.rolloutPercentage),
          failureThresholdPercentage: Number(values.failureThresholdPercentage),
          versionCode: Number(values.versionCode),
        }),
      });
    } catch (error) {
      showMessage(error.message, true);
      return;
    }
    showMessage(form.elements.enabled.checked
      ? 'Distribuicao atualizada. Os lockers elegiveis receberao o manifesto no proximo ciclo seguro.'
      : 'Distribuicao pausada.');
    await loadState({ skipCapture: true });
    return;
  }
  if (!event.target.matches('.resident-form')) return;
  event.preventDefault();
  await saveResident(event.target).catch((error) => showMessage(error.message, true));
});

mfaRecoveryToggle.addEventListener('click', () => {
  setMfaRecoveryMode(!state.mfa?.recoveryMode);
});

mfaBackButton.addEventListener('click', () => showLogin());

document.querySelector('#copy-recovery-codes').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(state.recoveryCodes.join('\n'));
    recoveryMessage.textContent = 'Codigos copiados.';
  } catch (_error) {
    recoveryMessage.textContent = 'Nao foi possivel copiar automaticamente.';
  }
});

document.querySelector('#continue-after-recovery').addEventListener('click', async () => {
  showAdmin();
  await loadState().catch((error) => showMessage(error.message, true));
});

async function bootstrap() {
  const { response, payload } = await authRequest('/api/auth/session');
  if (!response.ok || !payload.session?.csrfToken) {
    showLogin();
    return;
  }
  state.session = payload.session;
  state.csrfToken = payload.session.csrfToken;
  showAdmin();
  await loadState();
}

bootstrap().catch(() => showLogin('Nao foi possivel carregar a sessao.'));
window.setInterval(() => {
  if (state.session) refreshState({ skipRenderWhileEditing: true }).catch(() => {});
}, 8000);
