import { Sha256 } from '@aws-crypto/sha256-js';
import { IoTDataPlaneClient, PublishCommand } from '@aws-sdk/client-iot-data-plane';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { formatUrl } from '@aws-sdk/util-format-url';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';

export const IOT_MODE_DISABLED = 'disabled';
export const IOT_MODE_AWS = 'aws-iot';
export const IOT_WAKEUP_SCHEMA_VERSION = 1;
export const DEFAULT_IOT_TOPIC_PREFIX = 'preddita/v1';
export const DEFAULT_IOT_TICKET_TTL_SECONDS = 900;
export const IOT_FALLBACK_POLL_MS = 6000;
export const IOT_HEALTHY_POLL_MS = 30000;

function cleanText(value) {
  return String(value ?? '').trim();
}

function clampInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function normalizeEndpoint(value) {
  return cleanText(value).toLowerCase().replace(/\.$/, '');
}

function normalizeTopicPrefix(value) {
  return cleanText(value || DEFAULT_IOT_TOPIC_PREFIX).replace(/^\/+|\/+$/g, '');
}

function requireTopicSegment(value, name) {
  const segment = cleanText(value);
  if (!segment || !/^[A-Za-z0-9._-]{1,128}$/.test(segment)) {
    throw new Error(`${name} deve usar apenas letras, numeros, ponto, hifen ou sublinhado.`);
  }
  return segment;
}

function parseRoleAccountId(roleArn) {
  return cleanText(roleArn).match(/^arn:aws:iam::(\d{12}):role\/[A-Za-z0-9+=,.@_/-]+$/)?.[1] ?? '';
}

export function normalizeIotConfig(source = process.env) {
  return {
    mode: cleanText(source.PREDDITA_IOT_MODE || IOT_MODE_DISABLED).toLowerCase(),
    region: cleanText(source.PREDDITA_IOT_REGION),
    endpoint: normalizeEndpoint(source.PREDDITA_IOT_ENDPOINT),
    deviceRoleArn: cleanText(source.PREDDITA_IOT_DEVICE_ROLE_ARN),
    topicPrefix: normalizeTopicPrefix(source.PREDDITA_IOT_TOPIC_PREFIX),
    ticketTtlSeconds: clampInteger(
      source.PREDDITA_IOT_TICKET_TTL_SECONDS,
      DEFAULT_IOT_TICKET_TTL_SECONDS,
      900,
      3600,
    ),
  };
}

export function getIotStartupConfigErrors(configInput = process.env) {
  const config = configInput?.mode ? configInput : normalizeIotConfig(configInput);
  const errors = [];
  if (![IOT_MODE_DISABLED, IOT_MODE_AWS].includes(config.mode)) {
    errors.push('PREDDITA_IOT_MODE deve ser disabled ou aws-iot.');
    return errors;
  }
  if (config.mode === IOT_MODE_DISABLED) return errors;

  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(config.region)) {
    errors.push('PREDDITA_IOT_REGION deve conter uma regiao AWS valida.');
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,251}[a-z0-9]$/.test(config.endpoint)
      || config.endpoint.includes('/')
      || !config.endpoint.includes('.iot.')) {
    errors.push('PREDDITA_IOT_ENDPOINT deve conter somente o hostname Data-ATS do AWS IoT Core.');
  }
  if (!parseRoleAccountId(config.deviceRoleArn)) {
    errors.push('PREDDITA_IOT_DEVICE_ROLE_ARN deve conter o ARN de uma role IAM valida.');
  }
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(config.topicPrefix)) {
    errors.push('PREDDITA_IOT_TOPIC_PREFIX contem caracteres invalidos.');
  }
  return errors;
}

export function buildIotWakeupTopic(config, tenantId, lockerId) {
  const prefix = normalizeTopicPrefix(config?.topicPrefix);
  return `${prefix}/tenant/${requireTopicSegment(tenantId, 'tenantId')}/locker/${requireTopicSegment(lockerId, 'lockerId')}/wake`;
}

export function buildIotClientId(lockerId) {
  return `preddita-locker-${requireTopicSegment(lockerId, 'lockerId')}`.slice(0, 128);
}

export function createIotDeviceSessionPolicy({ region, accountId, clientId, topic }) {
  const arnPrefix = `arn:aws:iot:${region}:${accountId}`;
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: 'iot:Connect',
        Resource: `${arnPrefix}:client/${clientId}`,
      },
      {
        Effect: 'Allow',
        Action: 'iot:Subscribe',
        Resource: `${arnPrefix}:topicfilter/${topic}`,
      },
      {
        Effect: 'Allow',
        Action: 'iot:Receive',
        Resource: `${arnPrefix}:topic/${topic}`,
      },
    ],
  };
}

export async function presignIotWebSocketUrl({
  endpoint,
  region,
  credentials,
  expiresIn,
  signerFactory,
}) {
  const signer = signerFactory
    ? signerFactory({ credentials, region })
    : new SignatureV4({
      credentials,
      region,
      service: 'iotdevicegateway',
      sha256: Sha256,
    });
  const signed = await signer.presign(new HttpRequest({
    protocol: 'wss:',
    hostname: endpoint,
    method: 'GET',
    path: '/mqtt',
    headers: { host: endpoint },
  }), { expiresIn });
  return formatUrl(signed);
}

function createDefaultClients(config) {
  return {
    iot: new IoTDataPlaneClient({
      region: config.region,
      endpoint: `https://${config.endpoint}`,
    }),
    sts: new STSClient({ region: config.region }),
  };
}

export function createIotCommandBus(options = {}) {
  const config = options.config?.mode ? options.config : normalizeIotConfig(options.config);
  const configErrors = getIotStartupConfigErrors(config);
  const now = options.now ?? (() => Date.now());
  const createEventId = options.createEventId
    ?? (() => `wake-${now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`);
  let clients = options.clients ?? null;
  let lastPublishAt = '';
  let lastPublishError = '';

  function getClients() {
    clients ??= createDefaultClients(config);
    return clients;
  }

  function getStatus() {
    return {
      mode: config.mode,
      configured: config.mode === IOT_MODE_AWS && configErrors.length === 0,
      transport: config.mode === IOT_MODE_AWS ? 'mqtt-wss' : 'http-polling',
      fallbackPollMs: IOT_FALLBACK_POLL_MS,
      healthyPollMs: IOT_HEALTHY_POLL_MS,
      lastPublishAt,
      lastPublishError,
    };
  }

  async function publishWakeup({ tenantId, lockerId, reason, eventId, occurredAt } = {}) {
    if (config.mode !== IOT_MODE_AWS) {
      return { ok: false, skipped: 'disabled', ...getStatus() };
    }
    if (configErrors.length > 0) {
      throw new Error(configErrors.join(' '));
    }

    const topic = buildIotWakeupTopic(config, tenantId, lockerId);
    const payload = {
      schemaVersion: IOT_WAKEUP_SCHEMA_VERSION,
      eventId: cleanText(eventId) || createEventId(),
      lockerId: requireTopicSegment(lockerId, 'lockerId'),
      reason: cleanText(reason).slice(0, 80) || 'state-changed',
      occurredAt: cleanText(occurredAt) || new Date(now()).toISOString(),
    };
    try {
      await getClients().iot.send(new PublishCommand({
        topic,
        qos: 1,
        retain: false,
        payload: Buffer.from(JSON.stringify(payload)),
        contentType: 'application/json',
      }));
      lastPublishAt = new Date(now()).toISOString();
      lastPublishError = '';
      return { ok: true, topic, eventId: payload.eventId, publishedAt: lastPublishAt };
    } catch (error) {
      lastPublishError = cleanText(error?.code || error?.name || 'IOT_PUBLISH_FAILED').slice(0, 120);
      throw error;
    }
  }

  async function createDeviceTicket({ tenantId, lockerId } = {}) {
    if (config.mode !== IOT_MODE_AWS) {
      return {
        enabled: false,
        mode: IOT_MODE_DISABLED,
        fallbackPollMs: IOT_FALLBACK_POLL_MS,
      };
    }
    if (configErrors.length > 0) {
      throw new Error(configErrors.join(' '));
    }

    const accountId = parseRoleAccountId(config.deviceRoleArn);
    const topic = buildIotWakeupTopic(config, tenantId, lockerId);
    const clientId = buildIotClientId(lockerId);
    const policy = createIotDeviceSessionPolicy({
      region: config.region,
      accountId,
      clientId,
      topic,
    });
    const assumed = await getClients().sts.send(new AssumeRoleCommand({
      RoleArn: config.deviceRoleArn,
      RoleSessionName: `locker-${requireTopicSegment(lockerId, 'lockerId')}`.slice(0, 64),
      DurationSeconds: config.ticketTtlSeconds,
      Policy: JSON.stringify(policy),
    }));
    const temporary = assumed.Credentials;
    if (!temporary?.AccessKeyId || !temporary.SecretAccessKey || !temporary.SessionToken) {
      throw new Error('AWS STS nao retornou credenciais temporarias completas.');
    }
    const credentials = {
      accessKeyId: temporary.AccessKeyId,
      secretAccessKey: temporary.SecretAccessKey,
      sessionToken: temporary.SessionToken,
    };
    const url = await (options.presign ?? presignIotWebSocketUrl)({
      endpoint: config.endpoint,
      region: config.region,
      credentials,
      expiresIn: config.ticketTtlSeconds,
      signerFactory: options.signerFactory,
    });
    const credentialExpiration = Date.parse(temporary.Expiration);
    const requestedExpiration = now() + config.ticketTtlSeconds * 1000;
    const expiresAt = new Date(
      Number.isFinite(credentialExpiration)
        ? Math.min(credentialExpiration, requestedExpiration)
        : requestedExpiration
    ).toISOString();

    return {
      enabled: true,
      mode: IOT_MODE_AWS,
      transport: 'mqtt-wss',
      url,
      topic,
      clientId,
      qos: 1,
      expiresAt,
      fallbackPollMs: IOT_FALLBACK_POLL_MS,
      healthyPollMs: IOT_HEALTHY_POLL_MS,
    };
  }

  return {
    config,
    configErrors,
    getStatus,
    publishWakeup,
    createDeviceTicket,
  };
}
