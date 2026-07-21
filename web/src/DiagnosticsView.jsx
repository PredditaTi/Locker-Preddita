import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CommissioningPanel from './CommissioningPanel.jsx';
import { runDiagnostics, summarize } from './diagnostics.js';
import {
  DIAGNOSTIC_BRIGHTNESS_MAX,
  DIAGNOSTIC_BRIGHTNESS_MIN,
  DIAGNOSTIC_VOLUME_MAX,
  DIAGNOSTIC_VOLUME_MIN,
  getTechnicalStatus,
  retryDiagnosticSerial,
  setDiagnosticBrightness,
  setDiagnosticKeepScreenOn,
  setDiagnosticVolume,
} from './diagnosticBridge.js';
import edgeAgent from './edgeAgent.js';
import { KioskIcon, KioskIcons } from './kioskIcons.jsx';

const TABS = [
  { id: 'status', label: 'Status', icon: KioskIcons.activity },
  { id: 'doors', label: 'Portas', icon: KioskIcons.doorClosed },
  { id: 'connectivity', label: 'Conectividade', icon: KioskIcons.wifi },
  { id: 'camera', label: 'Camera', icon: KioskIcons.camera },
  { id: 'display', label: 'Tela', icon: KioskIcons.monitor },
  { id: 'update', label: 'Update', icon: KioskIcons.refresh },
];

const UPDATE_LABELS = {
  idle: 'Sem update em andamento',
  offered: 'Update oferecido',
  downloading: 'Baixando pacote',
  downloaded: 'Pacote validado',
  'awaiting-permission': 'Aguardando permissao do Android',
  installing: 'Instalacao iniciada',
  'up-to-date': 'Versao atualizada',
  failed: 'Falha no update',
};

const SAFE_ERROR_LABELS = {
  OK: 'Sem falhas',
  SIMULATED: 'Ambiente simulado',
  SERIAL_STARTING: 'Serial iniciando',
  SERIAL_PERMISSION_DENIED: 'Permissao da serial recusada',
  SERIAL_PORT_NOT_FOUND: 'Porta serial nao encontrada',
  SERIAL_UNAVAILABLE: 'Serial indisponivel',
  SESSION_REQUIRED: 'Sessao tecnica expirada',
  STATUS_UNAVAILABLE: 'Status nativo indisponivel',
};
const MAX_SESSION_DISPLAY_MS = 5 * 60 * 1000;

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes <= 0) return '--';
  const units = ['B', 'KB', 'MB', 'GB'];
  let amount = bytes;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`;
}

function formatSessionTime(milliseconds) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatMoment(value) {
  if (!value) return '--';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '--' : date.toLocaleTimeString('pt-BR');
}

function safeErrorLabel(code) {
  const normalized = String(code || '').trim().toUpperCase();
  return SAFE_ERROR_LABELS[normalized] || (normalized ? 'Falha tecnica registrada' : 'Sem falhas');
}

function DiagnosticStatusRow({ label, value, detail = '', tone = '' }) {
  return (
    <div className={`diagnostic-status-row${tone ? ` is-${tone}` : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {detail ? <small>{detail}</small> : null}
    </div>
  );
}

function DiagnosticSuiteResults({ suites, running }) {
  if (suites.length === 0 && !running) {
    return <p className="diagnostic-empty-copy">A bateria ainda nao foi executada nesta sessao.</p>;
  }

  return (
    <div className="diagnostic-results">
      {suites.map((suite) => (
        <section key={suite.name} className={`diagnostic-suite diagnostic-suite--${suite.status}`}>
          <header className="diagnostic-suite-header">
            <h3>{suite.name}</h3>
            <span className={`diagnostic-pill diagnostic-pill--${suite.status}`}>
              {suite.status === 'pass' ? 'OK' : suite.status === 'fail' ? 'Falhou' : 'Rodando'}
            </span>
          </header>
          <ul className="diagnostic-test-list">
            {suite.tests.map((test, index) => (
              <li key={`${test.name}-${index}`} className={`diagnostic-test diagnostic-test--${test.status}`}>
                <div className="diagnostic-test-line">
                  <span className={`diagnostic-tag diagnostic-tag--${test.status}`}>
                    {test.status === 'pass' ? 'OK' : test.status === 'fail' ? 'FAIL' : 'SKIP'}
                  </span>
                  <strong className="diagnostic-test-name">{test.name}</strong>
                  {test.durationMs > 0 ? <span className="diagnostic-test-time">{test.durationMs}ms</span> : null}
                </div>
                {test.detail ? <p className="diagnostic-test-detail">{test.detail}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export default function DiagnosticsView({
  lockerState,
  expiresAt,
  onAudit,
  onClose,
  onCommissioningComplete,
}) {
  const overlayRef = useRef(null);
  const videoRef = useRef(null);
  const cameraStreamRef = useRef(null);
  const onAuditRef = useRef(onAudit);
  const onCloseRef = useRef(onClose);
  onAuditRef.current = onAudit;
  onCloseRef.current = onClose;
  const [activeTab, setActiveTab] = useState('status');
  const [technicalStatus, setTechnicalStatus] = useState(() => getTechnicalStatus());
  const [deviceAuth, setDeviceAuth] = useState(() => edgeAgent.getNativeDeviceAuthStatus());
  const [operationalInfo, setOperationalInfo] = useState(() => edgeAgent.getOperationalInfo());
  const [suites, setSuites] = useState([]);
  const [running, setRunning] = useState(false);
  const [startedAt, setStartedAt] = useState(null);
  const [finishedAt, setFinishedAt] = useState(null);
  const [cameraState, setCameraState] = useState({ active: false, message: 'Preview parado.' });
  const [notice, setNotice] = useState('');
  const [now, setNow] = useState(Date.now());

  const summary = useMemo(() => summarize(suites), [suites]);
  const sessionRemaining = Math.min(
    MAX_SESSION_DISPLAY_MS,
    Math.max(0, (Number(expiresAt) || 0) - now),
  );
  const overallTone = technicalStatus.authorized && technicalStatus.serial.open ? 'success' : 'warn';
  const updateStatus = operationalInfo.appUpdater || {};
  const wakeupStatus = operationalInfo.commandWakeup || {};

  const audit = useCallback((entry) => {
    onAuditRef.current?.(entry);
  }, []);

  const refreshStatus = useCallback(() => {
    setTechnicalStatus(getTechnicalStatus());
    setDeviceAuth(edgeAgent.getNativeDeviceAuthStatus());
    setOperationalInfo(edgeAgent.getOperationalInfo());
  }, []);

  const stopCamera = useCallback((shouldAudit = true, updateState = true) => {
    for (const track of cameraStreamRef.current?.getTracks?.() || []) track.stop();
    cameraStreamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    if (updateState) setCameraState({ active: false, message: 'Preview parado.' });
    if (shouldAudit) {
      audit({
        kind: 'diagnostic-camera',
        message: 'Preview tecnico da camera encerrado.',
        outcome: 'stopped',
      });
    }
  }, [audit]);

  useEffect(() => {
    const previousFocus = document.activeElement;
    const closeButton = overlayRef.current?.querySelector('.diagnostic-close');
    closeButton?.focus();

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current?.();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...overlayRef.current.querySelectorAll(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)'
      )].filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) return;
      const activeIndex = focusable.indexOf(document.activeElement);
      const nextIndex = event.shiftKey
        ? (activeIndex <= 0 ? focusable.length - 1 : activeIndex - 1)
        : (activeIndex + 1) % focusable.length;
      event.preventDefault();
      focusable[nextIndex].focus();
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previousFocus?.focus();
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(refreshStatus, 5000);
    const refresh = () => refreshStatus();
    window.addEventListener('preddita-device-auth-changed', refresh);
    window.addEventListener('preddita-update-status', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('preddita-device-auth-changed', refresh);
      window.removeEventListener('preddita-update-status', refresh);
    };
  }, [refreshStatus]);

  useEffect(() => {
    if (activeTab !== 'camera' && cameraStreamRef.current) stopCamera(false);
  }, [activeTab, stopCamera]);

  useEffect(() => () => stopCamera(false, false), [stopCamera]);

  async function handleRun() {
    setRunning(true);
    setSuites([]);
    setStartedAt(new Date());
    setFinishedAt(null);
    setNotice('');
    audit({ kind: 'diagnostic-suite', message: 'Bateria tecnica iniciada.', outcome: 'started' });
    try {
      const result = await runDiagnostics(
        {
          board: lockerState?.deviceConfig?.board ?? 1,
          doorCount: lockerState?.deviceConfig?.doorCount ?? 24,
          sensorPolarity: lockerState?.deviceConfig?.sensorPolarity ?? 'zeroOpen',
        },
        ({ suites: next }) => setSuites(next),
      );
      const resultSummary = summarize(result);
      audit({
        kind: 'diagnostic-suite',
        message: 'Bateria tecnica concluida.',
        outcome: resultSummary.fail > 0 ? 'failed' : 'passed',
        meta: { pass: resultSummary.pass, fail: resultSummary.fail, skip: resultSummary.skip },
      });
    } catch {
      setNotice('A bateria foi interrompida. Consulte os logs protegidos do dispositivo.');
      audit({ kind: 'diagnostic-suite', message: 'Bateria tecnica interrompida.', outcome: 'failed' });
    } finally {
      setRunning(false);
      setFinishedAt(new Date());
      refreshStatus();
    }
  }

  async function handleCopyReport() {
    const report = {
      generatedAt: new Date().toISOString(),
      lockerId: lockerState?.tenant?.lockerId ?? '',
      board: lockerState?.deviceConfig?.board,
      doorCount: lockerState?.deviceConfig?.doorCount,
      sensorPolarity: lockerState?.deviceConfig?.sensorPolarity,
      startedAt: startedAt?.toISOString(),
      finishedAt: finishedAt?.toISOString(),
      summary,
      serial: technicalStatus.serial,
      network: technicalStatus.network,
      app: technicalStatus.app,
      suites,
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      setNotice('Relatorio sanitizado copiado.');
    } catch {
      setNotice('Nao foi possivel copiar o relatorio neste dispositivo.');
    }
  }

  async function handleStartCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraState({ active: false, message: 'Camera indisponivel neste ambiente.' });
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      cameraStreamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraState({ active: true, message: 'Preview local ativo. Nenhuma imagem e salva.' });
      audit({ kind: 'diagnostic-camera', message: 'Preview tecnico da camera iniciado.', outcome: 'started' });
    } catch {
      setCameraState({ active: false, message: 'Nao foi possivel iniciar a camera. Verifique a permissao.' });
      audit({ kind: 'diagnostic-camera', message: 'Preview tecnico da camera recusado.', outcome: 'failed' });
    }
  }

  function handleRetrySerial() {
    const accepted = retryDiagnosticSerial();
    setNotice(accepted ? 'Reconexao serial solicitada.' : 'A reconexao foi recusada pela bridge nativa.');
    audit({
      kind: 'diagnostic-serial',
      message: accepted ? 'Reconexao serial solicitada.' : 'Reconexao serial recusada.',
      outcome: accepted ? 'accepted' : 'rejected',
    });
    window.setTimeout(refreshStatus, 800);
  }

  function handleOpenProvisioning() {
    const accepted = edgeAgent.openNativeDeviceProvisioning();
    setNotice(accepted ? 'Provisionamento nativo aberto.' : 'Provisionamento indisponivel neste ambiente.');
    audit({
      kind: 'diagnostic-provisioning',
      message: accepted ? 'Provisionamento nativo solicitado.' : 'Provisionamento nativo indisponivel.',
      outcome: accepted ? 'opened' : 'rejected',
    });
  }

  function updateDisplayState(field, value) {
    setTechnicalStatus((current) => ({
      ...current,
      display: { ...current.display, [field]: value },
    }));
  }

  function handleBrightness(value) {
    const percent = Number(value);
    updateDisplayState('brightnessPercent', percent);
    if (!setDiagnosticBrightness(percent)) setNotice('Ajuste de brilho recusado pela bridge nativa.');
  }

  function handleVolume(value) {
    const percent = Number(value);
    updateDisplayState('mediaVolumePercent', percent);
    if (!setDiagnosticVolume(percent)) setNotice('Ajuste de volume recusado pela bridge nativa.');
  }

  function auditDisplay(label, value) {
    audit({
      kind: 'diagnostic-display',
      message: `${label} tecnico ajustado para ${value}.`,
      outcome: 'updated',
      meta: { setting: label.toLowerCase(), value },
    });
  }

  function handleKeepScreenOn(enabled) {
    updateDisplayState('keepScreenOn', enabled);
    const accepted = setDiagnosticKeepScreenOn(enabled);
    if (!accepted) setNotice('Ajuste da tela recusado pela bridge nativa.');
    audit({
      kind: 'diagnostic-display',
      message: `Tela sempre ligada ${enabled ? 'ativada' : 'desativada'} pelo tecnico.`,
      outcome: accepted ? 'updated' : 'rejected',
      meta: { setting: 'keep-screen-on', value: enabled },
    });
  }

  return (
    <div ref={overlayRef} className="diagnostic-overlay" role="dialog" aria-modal="true" aria-label="Console tecnico">
      <header className="diagnostic-header">
        <div>
          <p className="diagnostic-eyebrow">Console tecnico local</p>
          <h1 className="diagnostic-title">Diagnostico de campo</h1>
          <p className="diagnostic-subtitle">
            Locker {lockerState?.tenant?.lockerId || 'nao identificado'} · Board {lockerState?.deviceConfig?.board} · {lockerState?.deviceConfig?.doorCount} portas
          </p>
        </div>
        <div className="diagnostic-header-actions">
          <span className="diagnostic-session-time" role="status">Sessao {formatSessionTime(sessionRemaining)}</span>
          <button type="button" className="diagnostic-icon-button" onClick={refreshStatus} aria-label="Atualizar status" title="Atualizar status">
            <KioskIcon icon={KioskIcons.refresh} />
          </button>
          <button type="button" className="diagnostic-close" onClick={onClose} aria-label="Fechar console tecnico" title="Fechar console tecnico">
            <KioskIcon icon={KioskIcons.close} />
          </button>
        </div>
      </header>

      <nav className="diagnostic-mode-tabs" role="tablist" aria-label="Areas do console tecnico">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            className={activeTab === tab.id ? 'is-active' : ''}
            onClick={() => setActiveTab(tab.id)}
          >
            <KioskIcon icon={tab.icon} />
            {tab.label}
          </button>
        ))}
      </nav>

      {notice ? <div className="diagnostic-notice" role="status">{notice}</div> : null}

      <main className="diagnostic-content">
        {activeTab === 'status' ? (
          <section role="tabpanel" className="diagnostic-panel" aria-label="Status geral">
            <div className={`diagnostic-summary diagnostic-summary--${overallTone}`}>
              <div>
                <strong className="diagnostic-summary-text">
                  {overallTone === 'success' ? 'Console autenticado e hardware acessivel' : 'Atencao tecnica necessaria'}
                </strong>
                <span className="diagnostic-summary-detail">
                  {technicalStatus.serial.open ? 'Serial conectada' : safeErrorLabel(technicalStatus.serial.errorCode)} · {deviceAuth.provisioned ? 'Admin provisionado' : 'Admin pendente'}
                </span>
              </div>
              <span className={`diagnostic-state-badge is-${overallTone}`}>{overallTone === 'success' ? 'Operacional' : 'Atencao'}</span>
            </div>

            <div className="diagnostic-overview-grid">
              <DiagnosticStatusRow label="Bridge" value={edgeAgent.getHardwareInfo().bridgeVersion} detail={technicalStatus.available ? 'Android nativo' : 'Simulacao web'} />
              <DiagnosticStatusRow label="Serial" value={technicalStatus.serial.open ? 'Conectada' : 'Indisponivel'} detail={`${technicalStatus.serial.path || '--'} · ${technicalStatus.serial.baudRate || '--'} bps`} tone={technicalStatus.serial.open ? 'success' : 'danger'} />
              <DiagnosticStatusRow label="Admin Online" value={deviceAuth.provisioned ? 'Credencial protegida' : 'Nao provisionado'} detail={deviceAuth.lockerId || 'Sem identificador nativo'} tone={deviceAuth.provisioned ? 'success' : 'warn'} />
              <DiagnosticStatusRow label="Fila Edge" value={`${operationalInfo.pendingEvents} evento(s)`} detail={`${operationalInfo.pendingCompletions} conclusao(oes) pendente(s)`} tone={operationalInfo.pendingEvents ? 'warn' : 'success'} />
            </div>

            <section className="diagnostic-tool-section">
              <header className="diagnostic-section-heading">
                <div>
                  <h2>Bateria segura</h2>
                  <p>Leituras reais e regras simuladas. Esta bateria nao abre portas.</p>
                </div>
                <div className="diagnostic-actions">
                  <button type="button" className="diagnostic-secondary-action" onClick={handleCopyReport} disabled={running || suites.length === 0}>
                    <KioskIcon icon={KioskIcons.clipboard} />
                    Copiar relatorio
                  </button>
                  <button type="button" className="diagnostic-primary-action" onClick={handleRun} disabled={running}>
                    <KioskIcon icon={running ? KioskIcons.loading : KioskIcons.play} />
                    {running ? 'Executando' : suites.length ? 'Executar novamente' : 'Executar bateria'}
                  </button>
                </div>
              </header>
              <p className="diagnostic-run-summary">{summary.pass} OK · {summary.fail} falha(s) · {summary.skip} ignorado(s)</p>
              <DiagnosticSuiteResults suites={suites} running={running} />
            </section>
          </section>
        ) : null}

        {activeTab === 'doors' ? (
          <section role="tabpanel" className="diagnostic-panel" aria-label="Portas e comissionamento">
            <CommissioningPanel
              lockerState={lockerState}
              onAudit={onAudit}
              onComplete={onCommissioningComplete}
            />
          </section>
        ) : null}

        {activeTab === 'connectivity' ? (
          <section role="tabpanel" className="diagnostic-panel" aria-label="Conectividade">
            <header className="diagnostic-section-heading">
              <div><h2>Conectividade</h2><p>Leitura local da serial, rede e Edge Agent.</p></div>
              <div className="diagnostic-actions">
                <button type="button" className="diagnostic-secondary-action" onClick={handleOpenProvisioning}>
                  <KioskIcon icon={KioskIcons.key} />
                  Provisionar
                </button>
                <button type="button" className="diagnostic-secondary-action" onClick={handleRetrySerial}>
                  <KioskIcon icon={KioskIcons.refresh} />
                  Reconectar serial
                </button>
              </div>
            </header>
            <div className="diagnostic-status-list">
              <DiagnosticStatusRow label="RS-485" value={technicalStatus.serial.open ? 'Conectada' : safeErrorLabel(technicalStatus.serial.errorCode)} detail={`${technicalStatus.serial.path || '--'} · ${technicalStatus.serial.baudRate || '--'} bps · ${technicalStatus.serial.reconnectCount} reconexao(oes)`} tone={technicalStatus.serial.open ? 'success' : 'danger'} />
              <DiagnosticStatusRow label="Ultimo frame valido" value={formatMoment(technicalStatus.serial.lastFrameAt)} detail="Somente horario; payload nao e exibido." />
              <DiagnosticStatusRow label="Rede" value={technicalStatus.network.online ? 'Online' : 'Offline'} detail={technicalStatus.network.transport} tone={technicalStatus.network.online ? 'success' : 'warn'} />
              <DiagnosticStatusRow
                label="Admin Online"
                value={deviceAuth.provisioned ? 'HMAC provisionado' : 'Provisionamento pendente'}
                detail={operationalInfo.lastRemoteSyncAt
                  ? `Ultimo sync ${formatMoment(operationalInfo.lastRemoteSyncAt)} · ${operationalInfo.lastRemoteLatencyMs}ms`
                  : `${deviceAuth.lockerId || 'Identificador indisponivel'} · sem sync nesta execucao`}
                tone={deviceAuth.provisioned ? 'success' : 'warn'}
              />
              <DiagnosticStatusRow label="MQTT" value={wakeupStatus.connected ? 'Conectado' : wakeupStatus.running ? 'Reconectando' : 'Inativo'} detail={`Estado ${wakeupStatus.status || 'desconhecido'}`} tone={wakeupStatus.connected ? 'success' : 'warn'} />
              <DiagnosticStatusRow label="Fila offline" value={`${operationalInfo.pendingEvents} evento(s)`} detail={`${operationalInfo.commandExecutions} comando(s) no diario`} tone={operationalInfo.pendingEvents ? 'warn' : 'success'} />
            </div>
          </section>
        ) : null}

        {activeTab === 'camera' ? (
          <section role="tabpanel" className="diagnostic-panel" aria-label="Camera">
            <header className="diagnostic-section-heading">
              <div><h2>Camera local</h2><p>Preview temporario sem captura ou envio de imagem.</p></div>
              <button type="button" className={cameraState.active ? 'diagnostic-danger-action' : 'diagnostic-primary-action'} onClick={cameraState.active ? () => stopCamera(true) : handleStartCamera}>
                <KioskIcon icon={KioskIcons.camera} />
                {cameraState.active ? 'Parar preview' : 'Iniciar preview'}
              </button>
            </header>
            <div className="diagnostic-camera-layout">
              <div className={`diagnostic-camera-preview${cameraState.active ? ' is-active' : ''}`}>
                <video ref={videoRef} muted playsInline />
                {!cameraState.active ? <KioskIcon icon={KioskIcons.camera} /> : null}
              </div>
              <div className="diagnostic-status-list">
                <DiagnosticStatusRow label="Hardware" value={technicalStatus.camera.available ? 'Detectado' : 'Nao detectado'} />
                <DiagnosticStatusRow label="Permissao" value={technicalStatus.camera.permission} tone={technicalStatus.camera.permission === 'granted' ? 'success' : 'warn'} />
                <DiagnosticStatusRow label="Preview" value={cameraState.active ? 'Ativo' : 'Parado'} detail={cameraState.message} tone={cameraState.active ? 'success' : ''} />
              </div>
            </div>
          </section>
        ) : null}

        {activeTab === 'display' ? (
          <section role="tabpanel" className="diagnostic-panel" aria-label="Tela e som">
            <header className="diagnostic-section-heading"><div><h2>Tela e som</h2><p>Limites validados novamente no Android.</p></div></header>
            <div className="diagnostic-control-list">
              <label className="diagnostic-range-control">
                <span><strong>Brilho</strong><output>{technicalStatus.display.brightnessPercent}%</output></span>
                <input
                  type="range"
                  aria-label="Brilho"
                  min={DIAGNOSTIC_BRIGHTNESS_MIN}
                  max={DIAGNOSTIC_BRIGHTNESS_MAX}
                  step="5"
                  value={technicalStatus.display.brightnessPercent}
                  onChange={(event) => handleBrightness(event.target.value)}
                  onPointerUp={() => auditDisplay('Brilho', `${technicalStatus.display.brightnessPercent}%`)}
                  onKeyUp={() => auditDisplay('Brilho', `${technicalStatus.display.brightnessPercent}%`)}
                />
              </label>
              <label className="diagnostic-range-control">
                <span><strong>Volume de midia</strong><output>{technicalStatus.display.mediaVolumePercent}%</output></span>
                <input
                  type="range"
                  aria-label="Volume de midia"
                  min={DIAGNOSTIC_VOLUME_MIN}
                  max={DIAGNOSTIC_VOLUME_MAX}
                  step="5"
                  value={technicalStatus.display.mediaVolumePercent}
                  onChange={(event) => handleVolume(event.target.value)}
                  onPointerUp={() => auditDisplay('Volume', `${technicalStatus.display.mediaVolumePercent}%`)}
                  onKeyUp={() => auditDisplay('Volume', `${technicalStatus.display.mediaVolumePercent}%`)}
                />
              </label>
              <label className="diagnostic-toggle-control">
                <span><strong>Manter tela ligada</strong><small>Evita suspensao durante operacao do locker.</small></span>
                <input type="checkbox" role="switch" aria-label="Manter tela ligada" checked={technicalStatus.display.keepScreenOn} onChange={(event) => handleKeepScreenOn(event.target.checked)} />
              </label>
            </div>
          </section>
        ) : null}

        {activeTab === 'update' ? (
          <section role="tabpanel" className="diagnostic-panel" aria-label="Update e armazenamento">
            <header className="diagnostic-section-heading"><div><h2>Update e armazenamento</h2><p>Estado somente leitura; instalacao continua controlada pelo fluxo assinado.</p></div></header>
            <div className="diagnostic-status-list">
              <DiagnosticStatusRow label="Versao instalada" value={updateStatus.currentVersionName || technicalStatus.app.versionName || '--'} detail={`versionCode ${updateStatus.currentVersionCode || technicalStatus.app.versionCode || '--'}`} />
              <DiagnosticStatusRow label="Estado do update" value={UPDATE_LABELS[updateStatus.status] || updateStatus.status || 'Indisponivel'} detail={updateStatus.targetVersionName ? `Alvo ${updateStatus.targetVersionName}` : 'Nenhum alvo ativo'} tone={updateStatus.status === 'failed' ? 'danger' : updateStatus.status === 'up-to-date' ? 'success' : ''} />
              <DiagnosticStatusRow label="Progresso" value={`${Number(updateStatus.progressPercentage) || 0}%`} detail={updateStatus.lastError ? 'Falha sanitizada registrada no updater.' : 'Sem erro ativo'} />
              <DiagnosticStatusRow label="Armazenamento livre" value={formatBytes(technicalStatus.storage.freeBytes)} detail={`Total ${formatBytes(technicalStatus.storage.totalBytes)}`} tone={technicalStatus.storage.freeBytes > 200 * 1024 * 1024 ? 'success' : 'warn'} />
              <DiagnosticStatusRow label="Diarios web" value={formatBytes(technicalStatus.storage.journalBytes)} detail="Estado, filas e preferencias PREDDITA no WebView." />
            </div>
          </section>
        ) : null}
      </main>
    </div>
  );
}
