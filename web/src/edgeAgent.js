/**
 * Edge Agent contract used by the kiosk UI.
 *
 * This is the only web module allowed to know the native RS-485 bridge,
 * device authentication and the Admin Online transport. The React kiosk only
 * supplies state snapshots and domain callbacks.
 */

import Serial, {
  SENSOR_POLARITY_OPTIONS,
  createCommandSet,
  decodePackedStates,
  formatHex,
  normalizeSensorPolarity,
  parseHexFrame,
  parseResponse,
  validateFrame,
} from './serial.js';
import * as RemoteBridge from './remoteBridge.js';
import {
  applyDeviceEventSyncResult,
  upsertDeviceEventQueue,
} from './deviceEventQueue.js';
import {
  loadDeviceEventJournal,
  removeDeviceEventJournalEvents,
  saveDeviceEventJournalEvents,
} from './deviceEventJournal.js';
import {
  loadRemoteCommandExecutions,
  saveRemoteCommandExecutions,
  updateRemoteCommandExecution,
  upsertRemoteCommandExecution,
} from './remoteCommandJournal.js';
import {
  loadLockerState,
  persistLockerState,
} from './lockerWorkflow.js';

export {
  SENSOR_POLARITY_OPTIONS,
  createCommandSet,
  decodePackedStates,
  formatHex,
  normalizeSensorPolarity,
  parseHexFrame,
  parseResponse,
  validateFrame,
};

export const EDGE_AGENT_CONTRACT_VERSION = 2;

const REMOTE_COMPLETIONS_STORAGE_KEY = 'preddita_pending_remote_completions_v1';
const MAX_PENDING_REMOTE_COMPLETIONS = 20;
const MAX_PENDING_DEVICE_EVENTS = 160;
const MAX_DEVICE_EVENTS_PER_FLUSH = 4;
const MAX_REMOTE_COMPLETION_ATTEMPTS = 20;

function resolveStorage(storage) {
  if (storage !== undefined) return storage;
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch (_error) {
    return null;
  }
}

function normalizePendingRemoteCompletion(item, now) {
  if (!item || typeof item !== 'object') return null;
  const commandId = String(item.commandId ?? '').trim();
  if (!commandId) return null;

  return {
    commandId,
    result: item.result && typeof item.result === 'object' ? item.result : {},
    attempts: Number.isFinite(Number(item.attempts)) ? Math.max(0, Number(item.attempts)) : 0,
    queuedAt: String(item.queuedAt ?? now()),
    lastAttemptAt: String(item.lastAttemptAt ?? ''),
  };
}

function loadPendingRemoteCompletions(storage, now) {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(REMOTE_COMPLETIONS_STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => normalizePendingRemoteCompletion(item, now))
      .filter(Boolean)
      .slice(-MAX_PENDING_REMOTE_COMPLETIONS);
  } catch (_error) {
    return [];
  }
}

function savePendingRemoteCompletions(storage, items, now) {
  if (!storage) return;
  try {
    const safeItems = (Array.isArray(items) ? items : [])
      .map((item) => normalizePendingRemoteCompletion(item, now))
      .filter(Boolean)
      .slice(-MAX_PENDING_REMOTE_COMPLETIONS);
    if (safeItems.length === 0) {
      storage.removeItem(REMOTE_COMPLETIONS_STORAGE_KEY);
      return;
    }
    storage.setItem(REMOTE_COMPLETIONS_STORAGE_KEY, JSON.stringify(safeItems));
  } catch (_error) {
  }
}

function createEventId(type) {
  const suffix = Math.random().toString(36).slice(2, 10);
  return `edge-${type}-${Date.now().toString(36)}-${suffix}`;
}

function getResidentsRevision(residents, residentsUpdatedAt) {
  return String(residentsUpdatedAt ?? '').trim() || residents
    .map((resident) => `${resident?.id ?? ''}:${resident?.updatedAt ?? ''}`)
    .join('|');
}

function getNativeAppUpdater() {
  try {
    if (typeof window === 'undefined' || !window.PredditaUpdater) return null;
    return window.PredditaUpdater;
  } catch (_error) {
    return null;
  }
}

function createNativeAppUpdater() {
  return {
    getStatus() {
      const bridge = getNativeAppUpdater();
      if (!bridge?.getStatus) {
        return {
          available: false,
          currentVersionCode: 0,
          currentVersionName: '',
          status: 'idle',
        };
      }
      try {
        const parsed = JSON.parse(bridge.getStatus() || '{}');
        return parsed && typeof parsed === 'object'
          ? { ...parsed, available: true }
          : { available: true, status: 'idle' };
      } catch (_error) {
        return { available: true, status: 'failed', lastError: 'INVALID_NATIVE_UPDATE_STATUS' };
      }
    },
    requestUpdate(manifest) {
      const bridge = getNativeAppUpdater();
      if (!bridge?.requestUpdate) return false;
      try {
        return Boolean(bridge.requestUpdate(JSON.stringify(manifest)));
      } catch (_error) {
        return false;
      }
    },
  };
}

export class EdgeAgentRuntime {
  constructor(options = {}) {
    this.hardware = options.hardware ?? Serial;
    this.remote = options.remote ?? RemoteBridge;
    this.appUpdater = options.appUpdater ?? createNativeAppUpdater();
    this.storage = resolveStorage(options.storage);
    this.now = options.now ?? (() => new Date().toISOString());
    this.maxPendingEvents = options.maxPendingEvents ?? MAX_PENDING_DEVICE_EVENTS;
    this.maxEventsPerFlush = options.maxEventsPerFlush ?? MAX_DEVICE_EVENTS_PER_FLUSH;
    this.pendingEvents = loadDeviceEventJournal({
      storage: this.storage,
      maxItems: this.maxPendingEvents,
    });
    this.pendingCompletions = loadPendingRemoteCompletions(this.storage, this.now);
    this.commandExecutions = loadRemoteCommandExecutions(this.storage);
    this.eventsInFlight = false;
    this.remoteCycleInFlight = false;
  }

  get contractVersion() {
    return EDGE_AGENT_CONTRACT_VERSION;
  }

  isNative() {
    return this.hardware.isNative();
  }

  getHardwareInfo() {
    return this.hardware.getHardwareInfo();
  }

  loadLockerState() {
    return loadLockerState(this.storage);
  }

  persistLockerState(state) {
    return persistLockerState(state, this.storage);
  }

  readAll(...args) {
    return this.hardware.readAll(...args);
  }

  readStatus(...args) {
    return this.hardware.readStatus(...args);
  }

  setTimeout(...args) {
    return this.hardware.setTimeout(...args);
  }

  unlock(...args) {
    return this.hardware.unlock(...args);
  }

  close(...args) {
    return this.hardware.close(...args);
  }

  queryFirmware(...args) {
    return this.hardware.queryFirmware?.(...args) ?? this.hardware.firmware(...args);
  }

  getNativeDeviceAuthStatus() {
    return this.remote.getNativeDeviceAuthStatus();
  }

  openNativeDeviceProvisioning() {
    return this.remote.openNativeDeviceProvisioning();
  }

  fetchRemoteSnapshot() {
    return this.remote.fetchRemoteSnapshot();
  }

  publishRemoteStatus(payload) {
    return this.remote.publishRemoteStatus(payload);
  }

  getAppUpdateStatus() {
    return this.appUpdater.getStatus();
  }

  requestAppUpdate(manifest) {
    if (!manifest || typeof manifest !== 'object') return false;
    return this.appUpdater.requestUpdate(manifest);
  }

  queueEvent(type, payload = {}, options = {}) {
    const eventId = String(options.id ?? '').trim() || createEventId(type);
    const existing = this.pendingEvents.find((item) => item.id === eventId);
    const event = {
      id: eventId,
      type,
      payload,
      occurredAt: String(options.occurredAt ?? '').trim() || this.now(),
      attempts: existing?.attempts ?? 0,
      queuedAt: existing?.queuedAt || this.now(),
      lastAttemptAt: existing?.lastAttemptAt || '',
    };

    this.pendingEvents = upsertDeviceEventQueue(
      this.pendingEvents,
      event,
      this.maxPendingEvents,
    );
    saveDeviceEventJournalEvents([event], {
      storage: this.storage,
      maxItems: this.maxPendingEvents,
    });
    return event;
  }

  async flushPendingEvents(options = {}) {
    if (this.eventsInFlight || this.pendingEvents.length === 0) return false;

    this.eventsInFlight = true;
    const attemptedAt = this.now();
    const batch = this.pendingEvents.slice(0, this.maxEventsPerFlush);
    const batchIds = new Set(batch.map((item) => item.id));
    try {
      const result = await this.remote.publishRemoteEvents(batch);
      if (!result?.ok) {
        const updatedBatch = this.pendingEvents
          .map((item) => batchIds.has(item.id)
            ? { ...item, attempts: item.attempts + 1, lastAttemptAt: attemptedAt }
            : item)
          .slice(-this.maxPendingEvents);
        this.pendingEvents = updatedBatch;
        saveDeviceEventJournalEvents(
          updatedBatch.filter((item) => batchIds.has(item.id)),
          { storage: this.storage, maxItems: this.maxPendingEvents },
        );
        return false;
      }

      const syncResult = applyDeviceEventSyncResult(
        this.pendingEvents,
        result,
        attemptedAt,
        this.maxPendingEvents,
      );
      this.pendingEvents = syncResult.pending;
      removeDeviceEventJournalEvents(syncResult.acceptedIds, { storage: this.storage });
      saveDeviceEventJournalEvents(syncResult.failed, {
        storage: this.storage,
        maxItems: this.maxPendingEvents,
      });
      options.onNotifications?.(result.notifications ?? []);
      return syncResult.acceptedIds.length > 0;
    } finally {
      this.eventsInFlight = false;
    }
  }

  registerCommand(command) {
    const registration = upsertRemoteCommandExecution(this.commandExecutions, command, this.now());
    this.commandExecutions = saveRemoteCommandExecutions(registration.records, this.storage);
    return registration;
  }

  updateCommand(commandId, updates) {
    const updated = updateRemoteCommandExecution(
      this.commandExecutions,
      commandId,
      updates,
      this.now(),
    );
    this.commandExecutions = saveRemoteCommandExecutions(updated.records, this.storage);
    return updated.execution;
  }

  queueCompletion(commandId, result) {
    this.pendingCompletions = [
      ...this.pendingCompletions.filter((item) => item.commandId !== commandId),
      { commandId, result, attempts: 0, queuedAt: this.now(), lastAttemptAt: '' },
    ].slice(-MAX_PENDING_REMOTE_COMPLETIONS);
    savePendingRemoteCompletions(this.storage, this.pendingCompletions, this.now);
  }

  async submitCompletion(commandId, result) {
    const completed = await this.remote.completeRemoteCommand(commandId, result);
    if (!completed) this.queueCompletion(commandId, result);
    return Boolean(completed);
  }

  async flushPendingCompletions() {
    if (this.pendingCompletions.length === 0) return false;

    const stillPending = [];
    let completedAny = false;
    for (const item of this.pendingCompletions) {
      const attemptedAt = this.now();
      const completed = await this.remote.completeRemoteCommand(item.commandId, {
        ...item.result,
        retriedAt: attemptedAt,
      });
      if (completed) {
        completedAny = true;
      } else if (item.attempts < MAX_REMOTE_COMPLETION_ATTEMPTS) {
        stillPending.push({ ...item, attempts: item.attempts + 1, lastAttemptAt: attemptedAt });
      }
    }
    this.pendingCompletions = stillPending;
    savePendingRemoteCompletions(this.storage, stillPending, this.now);
    return completedAny;
  }

  async executeRemoteCommands(commands, options) {
    for (const command of commands) {
      if (command?.type !== 'openDoor') continue;

      const registration = this.registerCommand(command);
      let execution = registration.execution;
      if (!execution) continue;

      if (execution.status === 'completed' && execution.result) {
        await this.submitCompletion(command.id, execution.result);
        continue;
      }

      if (registration.conflict || ['executing', 'unknown'].includes(execution.status)) {
        const unknownResult = {
          ok: false,
          confirmed: false,
          executionId: execution.executionId,
          executionOutcomeUnknown: true,
          reason: 'execution-outcome-unknown',
          error: registration.conflict
            ? 'executionId local divergiu do servidor; reexecucao bloqueada por seguranca.'
            : 'O app reiniciou durante a execucao; reexecucao automatica bloqueada por seguranca.',
          door: Number.parseInt(command.door, 10),
          at: this.now(),
        };
        execution = this.updateCommand(command.id, {
          status: 'completed',
          result: unknownResult,
          completedAt: unknownResult.at,
        });
        await this.submitCompletion(command.id, execution?.result ?? unknownResult);
        continue;
      }

      const door = Number.parseInt(command.door, 10);
      const acknowledged = await this.remote.acknowledgeRemoteCommand(
        command.id,
        command.leaseId,
        execution.executionId,
      );
      if (!acknowledged) continue;

      if (acknowledged.terminal) {
        if (acknowledged.command?.result) {
          this.updateCommand(command.id, {
            status: 'completed',
            result: acknowledged.command.result,
            completedAt: acknowledged.command.completedAt || this.now(),
          });
        }
        continue;
      }

      if (!Number.isInteger(door) || door < 1 || door > options.doorCount) {
        const invalidDoorResult = {
          ok: false,
          executionId: execution.executionId,
          error: 'Porta invalida para este armario.',
          door: command.door,
          at: this.now(),
        };
        this.updateCommand(command.id, {
          status: 'completed',
          result: invalidDoorResult,
          completedAt: invalidDoorResult.at,
        });
        await this.submitCompletion(command.id, invalidDoorResult);
        continue;
      }

      execution = this.updateCommand(command.id, {
        status: 'executing',
        executingAt: this.now(),
      });
      if (!execution) continue;

      let actionResult;
      try {
        actionResult = await options.onOpenDoor({ door, command, executionId: execution.executionId });
      } catch (error) {
        actionResult = {
          ok: false,
          confirmed: false,
          reason: 'edge-action-failed',
          error: error?.message || 'Falha interna ao executar a abertura remota.',
        };
      }

      const completion = {
        ok: Boolean(actionResult?.ok),
        confirmed: Boolean(actionResult?.confirmed),
        reason: actionResult?.reason || '',
        error: actionResult?.error || '',
        executionId: execution.executionId,
        door,
        releasedDoor: Boolean(actionResult?.releasedDoor),
        releasedDeliveryId: actionResult?.releasedDeliveryId || '',
        pendingPhysicalClose: Boolean(actionResult?.pendingPhysicalClose),
        physicalOpenCycle: actionResult?.physicalOpenCycle ?? null,
        at: this.now(),
      };
      this.updateCommand(command.id, {
        status: 'completed',
        result: completion,
        completedAt: completion.at,
      });
      await this.submitCompletion(command.id, completion);
    }
  }

  async runRemoteCycle(options = {}) {
    if (this.remoteCycleInFlight) return { ok: false, skipped: 'already-running' };

    this.remoteCycleInFlight = true;
    try {
      await this.flushPendingCompletions();
      await this.flushPendingEvents({ onNotifications: options.onNotifications });
      const status = options.status ?? {};
      await this.remote.publishRemoteStatus({
        ...status,
        device: {
          ...(status.device ?? {}),
          appUpdater: this.getAppUpdateStatus(),
        },
      });

      const snapshot = await this.remote.fetchRemoteSnapshot();
      if (!snapshot) return { ok: false, offline: true };

      const residents = Array.isArray(snapshot.residents) ? snapshot.residents : [];
      const mappedResidents = residents
        .map((resident) => this.remote.mapRemoteResidentToRecipient(resident))
        .filter((resident) => resident.id);
      options.onResidents?.(
        mappedResidents,
        getResidentsRevision(residents, snapshot.residentsUpdatedAt),
      );

      const commands = Array.isArray(snapshot.commands) ? snapshot.commands : [];
      await this.executeRemoteCommands(
        commands,
        {
          doorCount: Number.parseInt(options.doorCount, 10) || 0,
          onOpenDoor: options.onOpenDoor,
        },
      );
      const updateRequested = commands.length === 0
        && Boolean(options.canInstallUpdate)
        && Boolean(snapshot.appUpdate)
        && this.requestAppUpdate(snapshot.appUpdate);
      return { ok: true, snapshot, updateRequested };
    } finally {
      this.remoteCycleInFlight = false;
    }
  }
}

const edgeAgent = new EdgeAgentRuntime();

export default edgeAgent;
