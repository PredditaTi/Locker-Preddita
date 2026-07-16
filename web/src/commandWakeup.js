const MAX_SEEN_EVENT_IDS = 100;
const MIN_RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_DELAY_MS = 60000;

function cleanText(value) {
  return String(value ?? '').trim();
}

function safeErrorCode(error) {
  const value = cleanText(error?.code || error?.name || 'MQTT_CONNECTION_FAILED');
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100) || 'MQTT_CONNECTION_FAILED';
}

function defaultStatus() {
  return {
    enabled: false,
    state: 'disabled',
    connected: false,
    transport: 'http-polling',
    lastConnectedAt: '',
    lastMessageAt: '',
    lastError: '',
    reconnectAttempt: 0,
    healthyPollMs: 30000,
    fallbackPollMs: 6000,
  };
}

export class CommandWakeupRuntime {
  constructor(options = {}) {
    this.fetchTicket = options.fetchTicket;
    this.connect = options.connect ?? null;
    this.loadConnector = options.loadConnector ?? (async () => {
      const mqtt = await import('mqtt');
      const connector = mqtt.connect ?? mqtt.default?.connect;
      if (typeof connector !== 'function') throw new Error('MQTT_CONNECTOR_UNAVAILABLE');
      return connector;
    });
    this.now = options.now ?? (() => new Date().toISOString());
    this.setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
    this.random = options.random ?? Math.random;
    this.client = null;
    this.reconnectTimer = null;
    this.generation = 0;
    this.stopped = true;
    this.onWake = null;
    this.topic = '';
    this.lockerId = '';
    this.seenEventIds = [];
    this.status = defaultStatus();
  }

  getStatus() {
    return { ...this.status };
  }

  async start({ onWake } = {}) {
    this.stop();
    this.stopped = false;
    this.onWake = typeof onWake === 'function' ? onWake : null;
    this.generation += 1;
    await this.connectWithFreshTicket(this.generation);
    return this.getStatus();
  }

  stop() {
    this.stopped = true;
    this.generation += 1;
    if (this.reconnectTimer) {
      this.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const client = this.client;
    this.client = null;
    this.topic = '';
    this.lockerId = '';
    if (client) {
      try {
        client.removeAllListeners?.();
        client.end?.(true);
      } catch (_error) {
      }
    }
    this.status = {
      ...this.status,
      state: this.status.enabled ? 'disconnected' : 'disabled',
      connected: false,
    };
  }

  async connectWithFreshTicket(generation) {
    if (this.stopped || generation !== this.generation) return;
    this.status = {
      ...this.status,
      state: 'connecting',
      connected: false,
      lastError: '',
    };

    let ticket;
    try {
      ticket = await this.fetchTicket?.();
    } catch (error) {
      this.handleConnectionFailure(error, generation);
      return;
    }
    if (this.stopped || generation !== this.generation) return;
    if (!ticket || typeof ticket !== 'object') {
      this.handleConnectionFailure({ code: 'MQTT_TICKET_UNAVAILABLE' }, generation);
      return;
    }
    if (!ticket.enabled) {
      this.status = {
        ...defaultStatus(),
        fallbackPollMs: Number(ticket.fallbackPollMs) || 6000,
      };
      return;
    }
    if (!/^wss:\/\//i.test(cleanText(ticket.url)) || !cleanText(ticket.topic) || !cleanText(ticket.clientId)) {
      this.handleConnectionFailure({ code: 'INVALID_MQTT_TICKET' }, generation);
      return;
    }

    this.topic = cleanText(ticket.topic);
    this.lockerId = this.topic.match(/\/locker\/([^/]+)\/wake$/)?.[1] ?? '';
    this.status = {
      ...this.status,
      enabled: true,
      state: 'connecting',
      connected: false,
      transport: 'mqtt-wss',
      healthyPollMs: Number(ticket.healthyPollMs) || 30000,
      fallbackPollMs: Number(ticket.fallbackPollMs) || 6000,
    };

    let client;
    try {
      const connector = this.connect ?? await this.loadConnector();
      if (this.stopped || generation !== this.generation) return;
      client = connector(ticket.url, {
        clientId: ticket.clientId,
        clean: false,
        protocolVersion: 4,
        reconnectPeriod: 0,
        connectTimeout: 10000,
        keepalive: 30,
        resubscribe: false,
      });
    } catch (error) {
      this.handleConnectionFailure(error, generation);
      return;
    }
    if (this.stopped || generation !== this.generation) {
      client.end?.(true);
      return;
    }
    this.client = client;
    client.on('connect', () => this.handleConnect(client, generation, Number(ticket.qos) || 1));
    client.on('message', (topic, payload) => this.handleMessage(topic, payload, generation));
    client.on('error', (error) => this.handleConnectionFailure(error, generation));
    client.on('close', () => this.handleClose(generation));
  }

  handleConnect(client, generation, qos) {
    if (this.stopped || generation !== this.generation || client !== this.client) return;
    client.subscribe(this.topic, { qos }, (error) => {
      if (this.stopped || generation !== this.generation || client !== this.client) return;
      if (error) {
        this.handleConnectionFailure(error, generation);
        client.end?.(true);
        return;
      }
      this.status = {
        ...this.status,
        state: 'connected',
        connected: true,
        lastConnectedAt: this.now(),
        lastError: '',
        reconnectAttempt: 0,
      };
    });
  }

  handleMessage(topic, payload, generation) {
    if (this.stopped || generation !== this.generation || topic !== this.topic) return;
    let message;
    try {
      message = JSON.parse(String(payload));
    } catch (_error) {
      return;
    }
    const eventId = cleanText(message?.eventId);
    if (message?.schemaVersion !== 1 || cleanText(message?.lockerId) !== this.lockerId || !eventId) return;
    if (this.seenEventIds.includes(eventId)) return;
    this.seenEventIds = [...this.seenEventIds, eventId].slice(-MAX_SEEN_EVENT_IDS);
    this.status = { ...this.status, lastMessageAt: this.now() };
    Promise.resolve(this.onWake?.({
      eventId,
      reason: cleanText(message.reason),
      occurredAt: cleanText(message.occurredAt),
    })).catch(() => {});
  }

  handleConnectionFailure(error, generation) {
    if (this.stopped || generation !== this.generation) return;
    this.status = {
      ...this.status,
      enabled: true,
      state: 'error',
      connected: false,
      transport: 'mqtt-wss',
      lastError: safeErrorCode(error),
    };
    this.scheduleReconnect(generation);
  }

  handleClose(generation) {
    if (this.stopped || generation !== this.generation) return;
    this.status = {
      ...this.status,
      state: 'disconnected',
      connected: false,
    };
    this.scheduleReconnect(generation);
  }

  scheduleReconnect(generation) {
    if (this.stopped || generation !== this.generation || this.reconnectTimer) return;
    const attempt = this.status.reconnectAttempt + 1;
    const baseDelay = Math.min(MAX_RECONNECT_DELAY_MS, MIN_RECONNECT_DELAY_MS * (2 ** Math.min(attempt - 1, 5)));
    const delay = Math.round(baseDelay * (0.85 + this.random() * 0.3));
    this.status = { ...this.status, reconnectAttempt: attempt };
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      const previous = this.client;
      this.client = null;
      try {
        previous?.removeAllListeners?.();
        previous?.end?.(true);
      } catch (_error) {
      }
      void this.connectWithFreshTicket(generation);
    }, delay);
  }
}

export function createCommandWakeupRuntime(options = {}) {
  return new CommandWakeupRuntime(options);
}
