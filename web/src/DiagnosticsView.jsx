import React, { useEffect, useMemo, useRef, useState } from 'react';
import CommissioningPanel from './CommissioningPanel.jsx';
import { runDiagnostics, summarize } from './diagnostics.js';
import {
  getNativeDeviceAuthStatus,
  openNativeDeviceProvisioning,
} from './remoteBridge.js';

/**
 * Tela de diagnostico embutida.
 *
 * Renderiza como overlay full-screen (z-index alto), nao mexe no roteamento
 * do App. Pode ser fechada com o botao "Fechar" ou via API exposta no hook.
 */
export default function DiagnosticsView({ lockerState, onClose, onCommissioningComplete }) {
  const [mode, setMode] = useState('diagnostics');
  const [running, setRunning] = useState(false);
  const [suites, setSuites] = useState([]);
  const [startedAt, setStartedAt] = useState(null);
  const [finishedAt, setFinishedAt] = useState(null);
  const [deviceAuth, setDeviceAuth] = useState(() => getNativeDeviceAuthStatus());
  const reportRef = useRef(null);

  const summary = useMemo(() => summarize(suites), [suites]);
  const overall = !running && suites.length > 0
    ? (summary.fail > 0 ? 'fail' : 'pass')
    : (running ? 'running' : 'idle');

  useEffect(() => {
    const refresh = () => setDeviceAuth(getNativeDeviceAuthStatus());
    window.addEventListener('preddita-device-auth-changed', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener('preddita-device-auth-changed', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  async function handleRun() {
    setRunning(true);
    setSuites([]);
    setStartedAt(new Date());
    setFinishedAt(null);
    try {
      await runDiagnostics(
        {
          board: lockerState?.deviceConfig?.board ?? 1,
          doorCount: lockerState?.deviceConfig?.doorCount ?? 24,
          sensorPolarity: lockerState?.deviceConfig?.sensorPolarity ?? 'zeroOpen',
        },
        ({ suites: next }) => setSuites(next),
      );
    } catch (error) {
      // o runner ja captura erros por teste; isso aqui so pega panico fatal
      // eslint-disable-next-line no-console
      console.error('[diagnostics] erro fatal:', error);
    } finally {
      setRunning(false);
      setFinishedAt(new Date());
    }
  }

  function handleCopyReport() {
    const report = {
      base: typeof window !== 'undefined' ? window.location?.href : '',
      lockerId: lockerState?.tenant?.lockerId ?? '',
      board: lockerState?.deviceConfig?.board,
      doorCount: lockerState?.deviceConfig?.doorCount,
      sensorPolarity: lockerState?.deviceConfig?.sensorPolarity,
      startedAt: startedAt?.toISOString(),
      finishedAt: finishedAt?.toISOString(),
      summary,
      suites,
      deviceAuth,
    };
    const text = JSON.stringify(report, null, 2);
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(
        () => window.alert('Relatorio copiado para a area de transferencia.'),
        () => fallbackCopy(text),
      );
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    if (reportRef.current) {
      reportRef.current.value = text;
      reportRef.current.select();
      try { document.execCommand('copy'); } catch (_error) {}
    }
  }

  return (
    <div className="diagnostic-overlay" role="dialog" aria-modal="true" aria-label="Modo diagnostico">
      <header className="diagnostic-header">
        <div>
          <p className="diagnostic-eyebrow">Modo diagnostico</p>
          <h1 className="diagnostic-title">
            {mode === 'diagnostics' ? 'Test agent embutido' : 'Comissionamento do locker'}
          </h1>
          <p className="diagnostic-subtitle">
            Locker {lockerState?.tenant?.lockerId || 'desconhecido'} · Board {lockerState?.deviceConfig?.board} · {lockerState?.deviceConfig?.doorCount} portas
          </p>
        </div>
        <button className="diagnostic-close" type="button" onClick={onClose}>Fechar</button>
      </header>

      <nav className="diagnostic-mode-tabs" aria-label="Ferramentas tecnicas">
        <button type="button" className={mode === 'diagnostics' ? 'is-active' : ''} onClick={() => setMode('diagnostics')}>
          Diagnostico
        </button>
        <button type="button" className={mode === 'commissioning' ? 'is-active' : ''} onClick={() => setMode('commissioning')}>
          Comissionamento
        </button>
      </nav>

      {mode === 'diagnostics' ? (
      <>
      <section className={`diagnostic-summary diagnostic-summary--${overall}`}>
        <div>
          <strong className="diagnostic-summary-text">
            {overall === 'idle' && 'Pronto para rodar'}
            {overall === 'running' && 'Rodando testes...'}
            {overall === 'pass' && 'Tudo passou'}
            {overall === 'fail' && `${summary.fail} falhou(ram)`}
          </strong>
          <span className="diagnostic-summary-detail">
            {summary.pass} OK · {summary.fail} fail · {summary.skip} skip
          </span>
        </div>
        <div className="diagnostic-actions">
          <button className="diagnostic-run" type="button" onClick={handleRun} disabled={running}>
            {running ? 'Rodando...' : suites.length === 0 ? 'Rodar bateria' : 'Rodar de novo'}
          </button>
          <button
            className="diagnostic-copy"
            type="button"
            onClick={handleCopyReport}
            disabled={running || suites.length === 0}
          >
            Copiar relatorio
          </button>
        </div>
      </section>

      <section className="diagnostic-device-auth" aria-label="Credencial segura do dispositivo">
        <div>
          <span className="diagnostic-device-auth-label">Conexao com Admin Online</span>
          <strong className="diagnostic-device-auth-status">
            {!deviceAuth.available && 'Disponivel somente no Android'}
            {deviceAuth.available && !deviceAuth.provisioned && 'Pendente de provisionamento'}
            {deviceAuth.provisioned && 'Protegida no Android Keystore'}
          </strong>
          {deviceAuth.provisioned ? (
            <span className="diagnostic-device-auth-detail">
              {deviceAuth.lockerId} · {deviceAuth.baseUrl}
            </span>
          ) : null}
        </div>
        <button
          className="diagnostic-provision"
          type="button"
          disabled={!deviceAuth.available}
          onClick={openNativeDeviceProvisioning}
        >
          {deviceAuth.provisioned ? 'Rotacionar credencial' : 'Provisionar conexao'}
        </button>
      </section>

      <section className="diagnostic-results">
        {suites.length === 0 && !running ? (
          <div className="diagnostic-empty">
            <p>Pressione <strong>Rodar bateria</strong> para iniciar.</p>
            <p className="diagnostic-hint">
              Cobre hardware (leitura real), UX entregador, UX morador e sincronia com admin.
              Nenhuma porta sera aberta fisicamente.
            </p>
          </div>
        ) : null}

        {suites.map((suite) => (
          <article key={suite.name} className={`diagnostic-suite diagnostic-suite--${suite.status}`}>
            <header className="diagnostic-suite-header">
              <h2>{suite.name}</h2>
              <span className={`diagnostic-pill diagnostic-pill--${suite.status}`}>
                {suite.status === 'pass' && 'OK'}
                {suite.status === 'fail' && 'FALHOU'}
                {suite.status === 'running' && 'rodando...'}
              </span>
            </header>
            <ul className="diagnostic-test-list">
              {suite.tests.map((test, index) => (
                <li key={`${test.name}-${index}`} className={`diagnostic-test diagnostic-test--${test.status}`}>
                  <div className="diagnostic-test-line">
                    <span className={`diagnostic-tag diagnostic-tag--${test.status}`}>
                      {test.status === 'pass' && 'OK'}
                      {test.status === 'fail' && 'FAIL'}
                      {test.status === 'skip' && 'SKIP'}
                    </span>
                    <strong className="diagnostic-test-name">{test.name}</strong>
                    {test.durationMs > 0 ? (
                      <span className="diagnostic-test-time">{test.durationMs}ms</span>
                    ) : null}
                  </div>
                  {test.detail ? (
                    <p className={`diagnostic-test-detail diagnostic-test-detail--${test.status}`}>
                      {test.detail}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </article>
        ))}
      </section>
      </>
      ) : (
        <CommissioningPanel
          lockerState={lockerState}
          onComplete={onCommissioningComplete}
        />
      )}

      <textarea ref={reportRef} className="diagnostic-clipboard" readOnly />
    </div>
  );
}
