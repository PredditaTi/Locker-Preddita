import React from 'react';
import { formatRecipientApartment } from './lockerWorkflow.js';
import { joinClasses } from './appUi.jsx';
import { COURIER_COPY, PICKUP_COPY, PUBLIC_HOME_COPY } from './publicKioskCopy.js';

const NUMBER_PAD_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'backspace'];

function NumberPad({ onKey, onBackspace, onClear, className = '' }) {
  return (
    <div className={joinClasses('public-number-pad', className)} aria-label="Teclado numerico">
      {NUMBER_PAD_KEYS.map((key) => (
        <button
          key={key}
          type="button"
          className={joinClasses('public-number-key', key === 'clear' || key === 'backspace' ? 'is-muted' : '')}
          onClick={() => {
            if (key === 'clear') onClear();
            else if (key === 'backspace') onBackspace();
            else onKey(key);
          }}
        >
          {key === 'clear' ? 'Limpar' : key === 'backspace' ? 'Apagar' : key}
        </button>
      ))}
    </div>
  );
}

function PublicHomeIcon({ type }) {
  if (type === 'courier') {
    return (
      <svg viewBox="0 0 64 64" role="img" aria-label="">
        <path d="M12 22 32 12l20 10-20 10L12 22Z" fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="5" />
        <path d="M12 22v22l20 10 20-10V22" fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="5" />
        <path d="M32 32v22" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="5" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 64 64" role="img" aria-label="">
      <circle cx="32" cy="22" r="10" fill="none" stroke="currentColor" strokeWidth="5" />
      <path d="M14 52c3-12 11-18 18-18s15 6 18 18" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="5" />
    </svg>
  );
}

export function PublicHome({ onCourier, onResident }) {
  return (
    <section className="public-kiosk-home" aria-label="Menu principal">
      <button type="button" className="public-home-action is-courier" onClick={onCourier}>
        <span className="public-home-icon" aria-hidden="true">
          <PublicHomeIcon type="courier" />
        </span>
        <strong>{PUBLIC_HOME_COPY.courierTitle}</strong>
        <span>{PUBLIC_HOME_COPY.courierText}</span>
      </button>
      <button type="button" className="public-home-action is-resident" onClick={onResident}>
        <span className="public-home-icon" aria-hidden="true">
          <PublicHomeIcon type="resident" />
        </span>
        <strong>{PUBLIC_HOME_COPY.residentTitle}</strong>
        <span>{PUBLIC_HOME_COPY.residentText}</span>
      </button>
    </section>
  );
}

export function PublicBackButton({ onClick }) {
  return (
    <button type="button" className="public-back-button" onClick={onClick}>
      Voltar
    </button>
  );
}

export function CourierApartmentStep({
  tenantName,
  search,
  recipients,
  onSearchChange,
  onKey,
  onBackspace,
  onClear,
  onSelectRecipient,
  onBack,
}) {
  return (
    <section className="public-kiosk-screen public-kiosk-screen--apartment">
      <header className="public-kiosk-header">
        <div>
          <span className="public-kiosk-site">{tenantName}</span>
          <h1>{COURIER_COPY.apartmentTitle}</h1>
          <p>{COURIER_COPY.apartmentSubtitle}</p>
        </div>
        <PublicBackButton onClick={onBack} />
      </header>

      <div className="public-apartment-layout">
        <section className="public-apartment-input">
          <label htmlFor="public-apartment-search">Apartamento</label>
          <input
            id="public-apartment-search"
            value={search}
            inputMode="numeric"
            placeholder="000"
            onChange={(event) => onSearchChange(event.target.value)}
          />
          <NumberPad onKey={onKey} onBackspace={onBackspace} onClear={onClear} />
        </section>

        <section className="public-apartment-results" aria-label="Apartamentos encontrados">
          <span className="public-result-count">{recipients.length} resultado{recipients.length === 1 ? '' : 's'}</span>
          <div className="public-apartment-grid">
            {recipients.map((recipient) => (
              <button key={recipient.id} type="button" className="public-apartment-card" onClick={() => onSelectRecipient(recipient.id)}>
                {formatRecipientApartment(recipient)}
              </button>
            ))}
            {recipients.length === 0 ? (
              <div className="public-empty-message">Nenhum apartamento encontrado.</div>
            ) : null}
          </div>
        </section>
      </div>
    </section>
  );
}

export function CourierConfirmStep({ tenantName, recipient, isBusy, onBack, onConfirm }) {
  return (
    <section className="public-kiosk-screen public-kiosk-screen--confirm">
      <header className="public-kiosk-header">
        <div>
          <span className="public-kiosk-site">{tenantName}</span>
          <h1>{COURIER_COPY.confirmTitle}</h1>
          <p>{COURIER_COPY.confirmText}</p>
        </div>
        <PublicBackButton onClick={onBack} />
      </header>
      <div className="public-confirm-card">
        <span>Apartamento</span>
        <strong>{recipient ? formatRecipientApartment(recipient) : 'Nao selecionado'}</strong>
      </div>
      <div className="public-action-bar">
        <button type="button" className="public-secondary-button" onClick={onBack}>Corrigir</button>
        <button type="button" className="public-primary-button" onClick={onConfirm} disabled={isBusy || !recipient}>
          {isBusy ? 'Abrindo...' : 'Abrir porta'}
        </button>
      </div>
    </section>
  );
}

export function CourierDoorStep({
  delivery,
  stage,
  secondsLeft,
  isBusy,
  onStored,
  onDoesNotFit,
  onCancel,
}) {
  const isWaiting = stage === 'waiting-small-close';
  const isLarge = stage === 'large';
  const isConfirming = stage.includes('confirming');
  const title = isWaiting ? COURIER_COPY.waitSmallCloseTitle : isLarge ? COURIER_COPY.openLargeTitle : COURIER_COPY.openSmallTitle;
  const text = isWaiting
    ? `${COURIER_COPY.waitSmallCloseText} Restam ${secondsLeft || 60} segundos.`
    : isLarge
    ? COURIER_COPY.openLargeText
    : COURIER_COPY.openSmallText;

  return (
    <section className="public-kiosk-screen public-kiosk-screen--door">
      <div className="public-door-hero">
        <span>{title}</span>
        <strong>Porta {delivery.door}</strong>
        <p>{text}</p>
      </div>
      <div className="public-door-details">
        <span>Apartamento</span>
        <strong>{delivery.recipientName}</strong>
      </div>
      <div className="public-action-bar">
        {isWaiting ? (
          <>
            <button type="button" className="public-primary-button" disabled>Aguardando fechar</button>
            <button type="button" className="public-danger-button" onClick={onCancel}>Cancelar</button>
          </>
        ) : isConfirming ? (
          <button type="button" className="public-primary-button" disabled>Verificando porta</button>
        ) : (
          <>
            <button type="button" className="public-primary-button" onClick={onStored} disabled={isBusy}>Item guardado</button>
            {!isLarge ? (
              <button type="button" className="public-secondary-button" onClick={onDoesNotFit} disabled={isBusy}>Nao coube</button>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

export function CourierSuccessStep({ presentation, delivery, qrImage, onNewDelivery, onHome }) {
  return (
    <section className="public-kiosk-screen public-kiosk-screen--success">
      <div className="public-success-copy">
        <span>Entrega registrada</span>
        <h1>{presentation.title}</h1>
        <p>{presentation.primaryText} {presentation.secondaryText}</p>
      </div>
      <div className="public-success-card">
        {presentation.shouldShowCredential ? (
          <>
            <span>PIN de retirada</span>
            <strong>{delivery.pin}</strong>
            {qrImage ? <img src={qrImage} alt="QR de retirada" /> : null}
          </>
        ) : (
          <>
            <span>Codigo protegido</span>
            <strong>Morador avisado</strong>
            <p>O PIN e o QR ficam salvos no painel e na fila de e-mail.</p>
          </>
        )}
      </div>
      <div className="public-action-bar">
        <button type="button" className="public-primary-button" onClick={onNewDelivery}>Nova entrega</button>
        <button type="button" className="public-secondary-button" onClick={onHome}>Inicio</button>
      </div>
    </section>
  );
}

export function ResidentPickupStep({
  tenantName,
  mode,
  value,
  presentation,
  isBusy,
  qrScannerState,
  activePickup,
  qrVideoRef,
  qrCanvasRef,
  onBack,
  onModeChange,
  onDigit,
  onClear,
  onBackspace,
  onCompletePickup,
  onStartQr,
  onStopQr,
}) {
  if (activePickup) {
    return (
      <section className="public-kiosk-screen public-kiosk-screen--pickup-open">
        <div className="public-door-hero">
          <span>{PICKUP_COPY.doorOpenTitle}</span>
          <strong>Porta {activePickup.door}</strong>
          <p>{PICKUP_COPY.doorOpenText}</p>
        </div>
        <button type="button" className="public-primary-button" onClick={onCompletePickup} disabled={isBusy}>
          {isBusy ? 'Verificando...' : 'Ja fechei a porta'}
        </button>
      </section>
    );
  }

  return (
    <section className="public-kiosk-screen public-kiosk-screen--pickup">
      <header className="public-kiosk-header">
        <div>
          <span className="public-kiosk-site">{tenantName}</span>
          <h1>{presentation.title}</h1>
          <p>{presentation.helper}</p>
        </div>
        <PublicBackButton onClick={onBack} />
      </header>
      <div className="public-pickup-layout">
        <section className="public-pin-panel">
          <div className="public-pin-display">{value || '------'}</div>
          <NumberPad onKey={onDigit} onBackspace={onBackspace} onClear={onClear} className="public-number-pad--pin" />
          <p className="public-pin-hint" aria-live="polite">
            {isBusy
              ? 'Abrindo sua porta...'
              : presentation.canSubmit
              ? 'Conferindo o PIN automaticamente.'
              : 'Digite 6 numeros. A porta abre sozinha.'}
          </p>
        </section>
        <section className="public-qr-panel">
          <button type="button" className="public-secondary-button" onClick={() => onModeChange(mode === 'pin' ? 'predditaQr' : 'pin')}>
            {mode === 'pin' ? PICKUP_COPY.qrTitle : 'Usar PIN'}
          </button>
          <div className="public-qr-camera">
            <video ref={qrVideoRef} muted playsInline />
            <canvas ref={qrCanvasRef} aria-hidden="true" />
            <p>{qrScannerState.error || qrScannerState.status || PICKUP_COPY.qrText}</p>
          </div>
          <button type="button" className="public-secondary-button" onClick={qrScannerState.active ? onStopQr : onStartQr}>
            {qrScannerState.active ? 'Parar camera' : 'Abrir camera'}
          </button>
        </section>
      </div>
    </section>
  );
}
