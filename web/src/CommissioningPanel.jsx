import React, { useMemo, useState } from 'react';
import {
  DOOR_SIZE_OPTIONS,
  buildCommissioningRecord,
  inferSensorPolarityFromClosedStateByte,
  normalizeCommissioningChannels,
  normalizeDoorSizes,
  normalizeUnlockTimeoutSeconds,
} from './commissioning.js';
import {
  createDoorCloseProof,
  createDoorOpenCycle,
  validateDirectDoorReading,
} from './doorSafety.js';
import Serial, { parseResponse } from './serial.js';

const OPEN_ATTEMPTS = 12;
const CLOSE_ATTEMPTS = 45;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createReading(parsed) {
  if (!parsed || parsed.type !== 'single') return null;
  return {
    channel: parsed.channel,
    status: parsed.state,
    detail: parsed.detail,
    source: 'single',
    stateByte: parsed.stateByte,
    statusKnown: parsed.statusKnown,
    validChecksum: parsed.validChecksum,
    ambiguous: parsed.ambiguous,
    sensorPolarity: parsed.sensorPolarity,
    readAt: new Date().toISOString(),
  };
}

function initialDraft(deviceConfig = {}) {
  const doorCount = Number(deviceConfig.doorCount) || 24;
  const doorSizes = normalizeDoorSizes(deviceConfig.doorSizes, doorCount);
  const channels = normalizeCommissioningChannels(
    deviceConfig.commissioning?.channels,
    doorCount,
    doorSizes,
  );
  const testedPolarity = channels.find((channel) => channel.status === 'passed')?.cycle?.sensorPolarity;

  return {
    board: String(deviceConfig.board || 1),
    doorCount: String(doorCount),
    unlockTimeoutSeconds: String(normalizeUnlockTimeoutSeconds(deviceConfig.unlockTimeoutSeconds)),
    channels,
    sensorPolarity: testedPolarity || '',
  };
}

function polarityLabel(value) {
  if (value === 'zeroOpen') return '0x00 aberta / 0x11 fechada';
  if (value === 'zeroClosed') return '0x00 fechada / 0x11 aberta';
  return 'Sera detectada no primeiro teste';
}

function explainFailure(reason) {
  const messages = {
    'not-direct': 'A placa nao retornou uma leitura individual.',
    'invalid-checksum': 'A resposta chegou com checksum invalido.',
    'ambiguous-status': 'O byte retornado nao identifica aberta ou fechada.',
    'expected-closed': 'A porta nao apareceu como fechada.',
    'expected-open': 'A porta nao apareceu como aberta depois do comando.',
    'sensor-did-not-transition': 'O sensor nao mudou de byte durante a abertura.',
    'polarity-changed': 'A polaridade divergiu dos canais ja testados.',
  };
  return messages[reason] || `Falha de validacao: ${reason || 'sem resposta'}.`;
}

export default function CommissioningPanel({ lockerState, onComplete }) {
  const [draft, setDraft] = useState(() => initialDraft(lockerState?.deviceConfig));
  const [busyChannel, setBusyChannel] = useState(0);
  const [stage, setStage] = useState('');
  const [notice, setNotice] = useState({ tone: '', text: '' });

  const board = Math.min(31, Math.max(1, Number.parseInt(draft.board, 10) || 1));
  const doorCount = Math.min(24, Math.max(1, Number.parseInt(draft.doorCount, 10) || 1));
  const unlockTimeoutSeconds = normalizeUnlockTimeoutSeconds(draft.unlockTimeoutSeconds);
  const passedCount = draft.channels.filter((channel) => channel.status === 'passed').length;
  const allPassed = passedCount === doorCount && draft.channels.length === doorCount;
  const progress = useMemo(
    () => Math.round((passedCount / Math.max(1, doorCount)) * 100),
    [doorCount, passedCount],
  );

  function resetCriticalField(field, value) {
    const nextDoorCount = field === 'doorCount'
      ? Math.min(24, Math.max(1, Number.parseInt(value, 10) || 1))
      : doorCount;
    const currentSizes = draft.channels.map((channel) => channel.size);
    setDraft((current) => ({
      ...current,
      [field]: value,
      channels: normalizeCommissioningChannels([], nextDoorCount, currentSizes),
      sensorPolarity: '',
    }));
    setNotice({ tone: 'warn', text: 'Os testes foram reiniciados porque a configuracao fisica mudou.' });
  }

  function updateDoorSize(channel, size) {
    setDraft((current) => ({
      ...current,
      sensorPolarity: '',
      channels: current.channels.map((item) => ({
        ...item,
        size: item.channel === channel ? size : item.size,
        status: 'pending',
        cycle: null,
        closeProof: null,
      })),
    }));
    setNotice({ tone: 'warn', text: 'Os testes foram reiniciados porque o mapa fisico mudou.' });
  }

  async function queryDoor(channel, sensorPolarity) {
    const result = await Serial.readStatus(board, channel);
    const parsed = result.ok ? parseResponse(result.hex, { sensorPolarity }) : null;
    return { result, parsed, reading: createReading(parsed) };
  }

  async function handleTestChannel(channel) {
    if (busyChannel) return;
    setBusyChannel(channel);
    setNotice({ tone: '', text: '' });

    try {
      setStage(`Porta ${channel}: confirme que esta fechada. Lendo sensor...`);
      const baselineProbe = await queryDoor(channel, 'zeroOpen');
      const inferredPolarity = inferSensorPolarityFromClosedStateByte(
        baselineProbe.parsed?.stateByte,
      );
      if (!inferredPolarity) {
        throw new Error('O byte da porta fechada nao e 0x00 nem 0x11.');
      }
      if (draft.sensorPolarity && draft.sensorPolarity !== inferredPolarity) {
        throw new Error('A leitura fechada diverge da polaridade detectada nos outros canais.');
      }

      const baselineParsed = parseResponse(baselineProbe.result.hex, {
        sensorPolarity: inferredPolarity,
      });
      const baseline = validateDirectDoorReading(createReading(baselineParsed), 'closed', {
        channel,
      });
      if (!baseline.ok) throw new Error(explainFailure(baseline.reason));

      setStage(`Porta ${channel}: configurando acionamento de ${unlockTimeoutSeconds}s...`);
      const timeoutResult = await Serial.setTimeout(board, channel, unlockTimeoutSeconds);
      if (!timeoutResult.ok) {
        throw new Error(`A placa recusou o tempo de acionamento: ${timeoutResult.error || 'sem resposta'}.`);
      }

      setStage(`Porta ${channel}: abrindo para identificacao...`);
      const unlockResult = await Serial.unlock(board, channel);
      let cycleResult = null;
      for (let attempt = 0; attempt < OPEN_ATTEMPTS; attempt += 1) {
        await wait(attempt === 0 ? 450 : 500);
        const probe = await queryDoor(channel, inferredPolarity);
        cycleResult = createDoorOpenCycle(baseline.reading, probe.reading, 'commissioning');
        if (cycleResult.ok) break;
      }
      if (!cycleResult?.ok) {
        const prefix = unlockResult.ok ? '' : `Comando: ${unlockResult.error || 'falhou'}. `;
        throw new Error(`${prefix}${explainFailure(cycleResult?.reason || 'expected-open')}`);
      }

      setStage(`Porta ${channel}: identificada. Feche a porta para concluir.`);
      if (unlockResult.simulated) {
        await wait(500);
        await Serial.close(board, channel);
      }

      let closeResult = null;
      for (let attempt = 0; attempt < CLOSE_ATTEMPTS; attempt += 1) {
        const probe = await queryDoor(channel, inferredPolarity);
        closeResult = createDoorCloseProof(cycleResult.cycle, probe.reading);
        if (closeResult.ok) break;
        await wait(1000);
      }
      if (!closeResult?.ok) {
        throw new Error('A porta nao confirmou o fechamento dentro de 45 segundos.');
      }

      setDraft((current) => ({
        ...current,
        sensorPolarity: inferredPolarity,
        channels: current.channels.map((item) =>
          item.channel === channel
            ? {
                ...item,
                status: 'passed',
                cycle: cycleResult.cycle,
                closeProof: closeResult.proof,
              }
            : item
        ),
      }));
      setNotice({ tone: 'success', text: `Porta ${channel} mapeada e sensor validado.` });
    } catch (error) {
      setDraft((current) => ({
        ...current,
        channels: current.channels.map((item) =>
          item.channel === channel
            ? { ...item, status: 'pending', cycle: null, closeProof: null }
            : item
        ),
      }));
      setNotice({ tone: 'danger', text: error?.message || `Nao foi possivel testar a porta ${channel}.` });
    } finally {
      setBusyChannel(0);
      setStage('');
    }
  }

  function handleComplete() {
    try {
      const doorSizes = normalizeDoorSizes(
        draft.channels.map((channel) => channel.size),
        doorCount,
      );
      const record = buildCommissioningRecord({
        board,
        doorCount,
        sensorPolarity: draft.sensorPolarity,
        unlockTimeoutSeconds,
        doorSizes,
        channels: draft.channels,
        startedAt: lockerState?.deviceConfig?.commissioning?.startedAt || new Date().toISOString(),
      });
      onComplete?.({
        board,
        doorCount,
        sensorPolarity: draft.sensorPolarity,
        unlockTimeoutSeconds,
        doorSizes,
        channels: record.channels,
        startedAt: record.startedAt,
        completedAt: record.completedAt,
      });
      setNotice({ tone: 'success', text: 'Comissionamento salvo. O mapa ja esta ativo no locker.' });
    } catch (error) {
      setNotice({ tone: 'danger', text: error?.message || 'Nao foi possivel concluir o comissionamento.' });
    }
  }

  return (
    <section className="commissioning-panel" aria-label="Assistente de comissionamento">
      <div className="commissioning-intro">
        <div>
          <p className="diagnostic-eyebrow">Instalacao fisica</p>
          <h2>Assistente de comissionamento</h2>
          <p>Feche a porta indicada antes de cada teste. O assistente abre somente o canal selecionado e espera o fechamento real.</p>
        </div>
        <div className="commissioning-progress" aria-label={`${passedCount} de ${doorCount} portas validadas`}>
          <strong>{passedCount}/{doorCount}</strong>
          <span>portas validadas</span>
          <div><i style={{ width: `${progress}%` }} /></div>
        </div>
      </div>

      <div className="commissioning-config">
        <label>
          <span>Board RS-485</span>
          <input type="number" min="1" max="31" value={draft.board} disabled={Boolean(busyChannel)} onChange={(event) => resetCriticalField('board', event.target.value)} />
        </label>
        <label>
          <span>Quantidade de portas</span>
          <input type="number" min="1" max="24" value={draft.doorCount} disabled={Boolean(busyChannel)} onChange={(event) => resetCriticalField('doorCount', event.target.value)} />
        </label>
        <label>
          <span>Tempo de acionamento</span>
          <select value={draft.unlockTimeoutSeconds} disabled={Boolean(busyChannel)} onChange={(event) => resetCriticalField('unlockTimeoutSeconds', event.target.value)}>
            {[1, 2, 3, 5, 8, 10].map((seconds) => <option key={seconds} value={seconds}>{seconds} segundos</option>)}
          </select>
        </label>
        <div className="commissioning-polarity">
          <span>Polaridade detectada</span>
          <strong>{polarityLabel(draft.sensorPolarity)}</strong>
        </div>
      </div>

      {stage ? <div className="commissioning-stage" role="status">{stage}</div> : null}
      {notice.text ? <div className={`commissioning-notice is-${notice.tone}`} role="status">{notice.text}</div> : null}

      <div className="commissioning-door-list">
        {draft.channels.map((channel) => (
          <article key={channel.channel} className={`commissioning-door is-${channel.status}`}>
            <div className="commissioning-door-number">
              <span>Canal</span>
              <strong>{channel.channel}</strong>
            </div>
            <label>
              <span>Tamanho fisico</span>
              <select value={channel.size} disabled={Boolean(busyChannel)} onChange={(event) => updateDoorSize(channel.channel, event.target.value)}>
                {DOOR_SIZE_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
            </label>
            <div className="commissioning-door-status">
              <span>Sensor</span>
              <strong>{channel.status === 'passed' ? 'Validado' : 'Pendente'}</strong>
            </div>
            <button type="button" disabled={Boolean(busyChannel)} onClick={() => handleTestChannel(channel.channel)}>
              {busyChannel === channel.channel ? 'Testando...' : channel.status === 'passed' ? 'Testar novamente' : 'Identificar e testar'}
            </button>
          </article>
        ))}
      </div>

      <div className="commissioning-footer">
        <p>{allPassed ? 'Todos os canais possuem prova fisica completa.' : 'A conclusao fica disponivel depois que todas as portas forem validadas.'}</p>
        <button type="button" onClick={handleComplete} disabled={!allPassed || Boolean(busyChannel)}>Concluir comissionamento</button>
      </div>
    </section>
  );
}
