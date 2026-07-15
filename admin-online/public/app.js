const API = '';
const TOKEN_KEY = 'preddita_admin_online_token';

const state = {
  view: 'overview',
  data: null,
  token: localStorage.getItem(TOKEN_KEY) || 'preddita-admin-local',
  editingResidentId: '',
  residentDrafts: {
    new: {},
    edit: {},
  },
  lastRole: '',
  trackingCommandId: '',
  trackingCommand: null,
};

const root = document.querySelector('#view-root');
const title = document.querySelector('#view-title');
const siteName = document.querySelector('#site-name');
const message = document.querySelector('#message');
const tokenInput = document.querySelector('#admin-token');
const deviceStatus = document.querySelector('#device-status');
const navList = document.querySelector('#nav-list');
const panelName = document.querySelector('#panel-name');
const panelDescription = document.querySelector('#panel-description');
const tokenLabel = document.querySelector('#token-label');

tokenInput.value = state.token;

const NAV_BY_ROLE = {
  sindico: [
    ['overview', 'Resumo'],
    ['doors', 'Portas'],
    ['residents', 'Apartamentos'],
    ['deliveries', 'Entregas'],
    ['audit', 'Auditoria'],
  ],
  super_admin: [
    ['platform', 'Admin geral'],
    ['overview', 'Armario atual'],
    ['doors', 'Portas'],
    ['residents', 'Apartamentos'],
    ['deliveries', 'Entregas'],
    ['audit', 'Auditoria'],
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

function doorSizeLabel(size) {
  return size === 'G' ? 'Grande' : 'Pequena';
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
  return state.data?.session || { role: 'sindico', label: 'Painel do Sindico' };
}

function roleNavItems() {
  return NAV_BY_ROLE[session().role] || NAV_BY_ROLE.sindico;
}

function isSuperAdmin() {
  return session().role === 'super_admin';
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

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      'x-admin-token': state.token,
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || 'Falha na API.');
  }
  return payload;
}

async function downloadAdminFile(path, filename) {
  const response = await fetch(`${API}${path}`, {
    headers: {
      'x-admin-token': state.token,
    },
  });
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
    state.view = role === 'super_admin' ? 'platform' : 'overview';
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
  const superAdmin = isSuperAdmin();
  panelName.textContent = superAdmin ? 'Admin Geral' : 'Sindico Online';
  panelDescription.textContent = superAdmin
    ? 'Visao PREDDITA de operacao, suporte, armarios e seguranca.'
    : 'Painel do condominio para portas, apartamentos e entregas.';
  tokenLabel.textContent = superAdmin ? 'Token PREDDITA ou sindico' : 'Token de acesso';
  siteName.textContent = superAdmin ? 'PREDDITA Operacao' : data?.tenant?.siteName || 'PREDDITA';
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
      <article class="stat-card"><span class="muted">Pequenas livres</span><strong>${escapeHtml(health.freeSmallDoorCount ?? doors.filter((door) => door.size !== 'G' && door.occupancy !== 'busy').length)}</strong></article>
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
                <span>${escapeHtml(locker.freeLargeDoorCount ?? 0)} grandes livres</span>
                <span>${escapeHtml(locker.occupiedDoorCount)} ocupadas</span>
                <span>${escapeHtml(locker.activeDeliveryCount)} entregas</span>
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
  const smallFree = doors.filter((door) => door.size !== 'G' && door.occupancy !== 'busy').length;
  const largeFree = doors.filter((door) => door.size === 'G' && door.occupancy !== 'busy').length;
  root.innerHTML = `
    ${ready ? '' : '<div class="message is-error">Armario sem confirmacao operacional recente. A abertura remota pode ficar pendente ate o dispositivo voltar a sincronizar.</div>'}
    ${renderCommandTracker()}
    <section class="door-summary panel">
      <div>
        <p class="eyebrow">Mapa fisico</p>
        <h3>Portas 1 e 2 grandes; demais pequenas</h3>
      </div>
      <div class="door-summary-metrics">
        <span>${escapeHtml(largeFree)} grandes livres</span>
        <span>${escapeHtml(smallFree)} pequenas livres</span>
        <span>${escapeHtml(doors.filter((door) => door.occupancy === 'busy').length)} ocupadas</span>
      </div>
    </section>
    <div class="door-grid">
      ${doors.map((door) => `
        <article class="door-card ${door.status === 'open' ? 'is-open' : ''} ${door.occupancy === 'busy' ? 'is-busy' : ''} ${door.size === 'G' ? 'is-large-door' : 'is-small-door'}">
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
  const withEvidence = deliveries.filter((delivery) => delivery.labelPhotoDataUrl).length;
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
              : '<div class="delivery-evidence-empty">Sem foto</div>'}
          </div>
          <div class="delivery-card-main">
            <div class="delivery-top">
              <div>
                <h3>${escapeHtml(deliveryUnitLabel(delivery))}</h3>
                <p class="muted">Porta ${escapeHtml(delivery.door)} | ${escapeHtml(doorSizeLabel(delivery.doorSize || delivery.size))} | PIN ${escapeHtml(delivery.pin || '--')}</p>
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
              <button class="ghost-button" data-notify-delivery="${escapeHtml(delivery.id)}">Reenviar PIN e QR</button>
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

function renderSystem() {
  title.textContent = 'Sistema';
  if (!isSuperAdmin()) {
    root.innerHTML = '<section class="panel"><h3>Acesso restrito</h3><p class="muted">Esta area e reservada ao Admin Geral PREDDITA.</p></section>';
    return;
  }
  root.innerHTML = `
    <div class="grid two">
      <section class="panel">
        <p class="eyebrow">Configuracao atual</p>
        <h3>${escapeHtml(state.data.tenant?.lockerId)}</h3>
        <p class="muted">Board ${escapeHtml(state.data.device?.board)} | ${escapeHtml(state.data.device?.doorCount)} portas</p>
      </section>
      <section class="panel">
        <p class="eyebrow">Seguranca</p>
        <h3>Tokens locais</h3>
        <p class="muted">Defina PREDDITA_SUPER_ADMIN_TOKEN, PREDDITA_ADMIN_TOKEN e PREDDITA_DEVICE_KEY antes de publicar na internet.</p>
      </section>
      <section class="panel">
        <p class="eyebrow">Exportacao</p>
        <h3>Relatorios CSV</h3>
        <p class="muted">Baixe dados operacionais para auditoria, suporte ou conferencia do sindico.</p>
        <div class="export-actions">
          <button class="ghost-button" data-export="residents">Apartamentos</button>
          <button class="ghost-button" data-export="deliveries">Entregas</button>
          <button class="ghost-button" data-export="audit">Auditoria</button>
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

  if (event.target.id === 'save-token') {
    state.token = tokenInput.value.trim();
    localStorage.setItem(TOKEN_KEY, state.token);
    showMessage('Token salvo.');
    await loadState().catch((error) => showMessage(error.message, true));
    return;
  }

  if (event.target.id === 'refresh-button') {
    await refreshState().catch((error) => showMessage(error.message, true));
    return;
  }

  const exportButton = event.target.closest('[data-export]');
  if (exportButton) {
    const kind = exportButton.dataset.export;
    const map = {
      residents: ['/api/admin/export/residents.csv', 'preddita-apartamentos.csv'],
      deliveries: ['/api/admin/export/deliveries.csv', 'preddita-entregas.csv'],
      audit: ['/api/admin/export/audit.csv', 'preddita-auditoria.csv'],
    };
    const target = map[kind];
    if (!target) return;
    await downloadAdminFile(target[0], target[1]).catch((error) => showMessage(error.message, true));
    return;
  }

  const doorButton = event.target.closest('[data-open-door]');
  if (doorButton) {
    const door = doorButton.dataset.openDoor;
    const doorData = (state.data.doors || []).find((item) => String(item.channel) === String(door));
    const requestedBy = isSuperAdmin() ? 'admin-geral-preddita' : 'sindico';
    const reason = window.prompt(
      doorData?.occupancy === 'busy'
        ? `Motivo para abrir e liberar a porta ocupada ${door}:`
        : `Motivo para abrir a porta ${door}:`,
      isSuperAdmin() ? 'Abertura remota pelo Admin Geral PREDDITA.' : 'Abertura remota pelo sindico.'
    );
    if (reason === null) return;
    const payload = await api(`/api/admin/doors/${door}/open`, {
      method: 'POST',
      body: JSON.stringify({ reason, requestedBy }),
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
      body: JSON.stringify({ requestedBy: 'sindico' }),
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
    if (!window.confirm('Remover este apartamento?')) return;
    await api(`/api/admin/residents/${encodeURIComponent(deleteButton.dataset.deleteResident)}`, { method: 'DELETE' });
    showMessage('Apartamento removido. O armario sincroniza automaticamente em alguns segundos.');
    await loadState();
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
  if (!event.target.matches('.resident-form')) return;
  event.preventDefault();
  await saveResident(event.target).catch((error) => showMessage(error.message, true));
});

loadState().catch((error) => showMessage(error.message, true));
window.setInterval(() => refreshState({ skipRenderWhileEditing: true }).catch(() => {}), 8000);
