import React from 'react';
import { formatRecipientApartment, getDeliveryStatusLabel, isDeliveryExpired } from './lockerWorkflow.js';

export function formatDateTime(value) {
  if (!value) return '--';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '--';
  return parsed.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function trimCode(value) {
  const clean = String(value ?? '').trim();
  return clean.length <= 20 ? clean : `${clean.slice(0, 18)}...`;
}

export function joinClasses(...parts) {
  return parts.filter(Boolean).join(' ');
}

export function Pill({ tone = '', children }) {
  return <div className={joinClasses('pill', tone ? `is-${tone}` : '')}>{children}</div>;
}

export function StatCard({ label, value, hint }) {
  return (
    <article className="stat-card">
      <div className="stat-top">
        <span className="stat-label">{label}</span>
      </div>
      <h3 className="stat-value">{value}</h3>
      {hint ? <p className="stat-hint">{hint}</p> : null}
    </article>
  );
}

export function RecipientCard({ recipient, selected, onSelect }) {
  const apartment = formatRecipientApartment(recipient);

  return (
    <button
      type="button"
      className={joinClasses('recipient-card', selected ? 'is-selected' : '')}
      onClick={onSelect}
    >
      <div className="recipient-top">
        <h3 className="recipient-name">{apartment}</h3>
      </div>
    </button>
  );
}

export function DeliveryCard({ delivery, tone = '', footer, titleOverride }) {
  return (
    <article className="delivery-card">
      <div className="delivery-top">
        <div>
          <h3 className="delivery-name">{titleOverride ?? delivery.unit ?? delivery.recipientName}</h3>
          <p className="delivery-meta">
            Porta {delivery.door} | Volume {delivery.size} | {delivery.unit}
          </p>
        </div>
        <span className={joinClasses('mini-tag', tone ? `is-${tone}` : '')}>
          {getDeliveryStatusLabel(delivery)}
        </span>
      </div>
      <div className="delivery-tags">
        <span className="mini-tag">PIN {delivery.pin}</span>
        <span className="mini-tag">{trimCode(delivery.orderCode)}</span>
        {delivery.externalCode ? (
          <span className="mini-tag is-warn">{trimCode(delivery.externalCode)}</span>
        ) : null}
        {isDeliveryExpired(delivery) ? <span className="mini-tag is-danger">Expirada</span> : null}
      </div>
      {footer}
    </article>
  );
}

export function DoorCard({ door }) {
  const physicalTone =
    door.physicalState.status === 'open'
      ? 'is-open'
      : door.physicalState.status === 'closed'
      ? 'is-closed'
      : 'is-unknown';

  return (
    <article
      className={joinClasses(
        'door-card',
        door.delivery ? 'is-busy' : 'is-free',
        door.physicalState.status === 'unknown' ? 'is-unknown' : ''
      )}
    >
      <div className="door-head">
        <div>
          <h3 className="door-title">{door.label}</h3>
          <p className="door-size">Volume {door.size}</p>
        </div>
        <span className={joinClasses('door-badge', door.delivery ? 'is-busy' : 'is-free')}>
          {door.occupancyLabel}
        </span>
      </div>
      <div className="door-sensor">
        <span className={joinClasses('door-dot', physicalTone)} />
        <p className="door-status">{door.physicalLabel}</p>
      </div>
      {door.delivery ? (
        <div className="delivery-tags">
          <span className="mini-tag">{trimCode(door.delivery.unit ?? door.delivery.recipientName)}</span>
        </div>
      ) : null}
    </article>
  );
}

export function AuditCard({ entry }) {
  return (
    <article className="audit-card">
      <div className="audit-top">
        <div className="audit-headline">
          <span className="audit-kind">{entry.kind}</span>
          <span className="small-copy">{formatDateTime(entry.at)}</span>
        </div>
      </div>
      <p className="audit-text">{entry.message}</p>
    </article>
  );
}
