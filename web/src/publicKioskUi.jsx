import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AUDIO_PROMPTS, AUDIO_VOLUME_MAX, AUDIO_VOLUME_MIN, createAudioGuidanceController } from './audioGuidance.js';
import { formatRecipientApartment } from './lockerWorkflow.js';
import { joinClasses } from './appUi.jsx';
import { KioskIcon, KioskIcons } from './kioskIcons.jsx';
import { COURIER_COPY, PICKUP_COPY, PUBLIC_HOME_COPY } from './publicKioskCopy.js';

const NUMBER_PAD_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'backspace'];
const KioskAudioContext = createContext(null);

export function KioskAudioProvider({ active, children }) {
  const controllerRef = useRef(null);
  const entriesRef = useRef(new Map());
  const sequenceRef = useRef(0);
  const selectedPromptRef = useRef(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  if (!controllerRef.current) {
    controllerRef.current = createAudioGuidanceController();
  }

  const [preferences, setPreferences] = useState(() => controllerRef.current.getPreferences());

  const syncSelection = useCallback(() => {
    const controller = controllerRef.current;
    if (!activeRef.current) {
      selectedPromptRef.current = null;
      controller.stop({ clearTransition: true });
      return;
    }

    const selected = [...entriesRef.current.values()].sort((left, right) => (
      AUDIO_PROMPTS[right.promptId].priority - AUDIO_PROMPTS[left.promptId].priority
      || right.sequence - left.sequence
    ))[0];

    if (!selected) {
      selectedPromptRef.current = null;
      controller.stop();
      return;
    }
    if (selected.promptId === selectedPromptRef.current) return;

    controller.stop();
    selectedPromptRef.current = selected.promptId;
    controller.play(selected.promptId, { transitionKey: selected.promptId });
  }, []);

  const registerPrompt = useCallback((promptId) => {
    if (!AUDIO_PROMPTS[promptId]) return () => {};
    const token = Symbol(promptId);
    entriesRef.current.set(token, { promptId, sequence: sequenceRef.current += 1 });
    syncSelection();
    return () => {
      entriesRef.current.delete(token);
      syncSelection();
    };
  }, [syncSelection]);

  const toggleMuted = useCallback(() => {
    const controller = controllerRef.current;
    const next = controller.setMuted(!controller.getPreferences().muted);
    setPreferences(next);
    if (!next.muted && selectedPromptRef.current) {
      controller.play(selectedPromptRef.current, {
        transitionKey: selectedPromptRef.current,
        force: true,
      });
    }
  }, []);

  const setVolume = useCallback((volume) => {
    setPreferences(controllerRef.current.setVolume(volume));
  }, []);

  const replay = useCallback(() => {
    if (!selectedPromptRef.current) return false;
    return controllerRef.current.play(selectedPromptRef.current, {
      transitionKey: selectedPromptRef.current,
      force: true,
    });
  }, []);

  useEffect(() => {
    syncSelection();
  }, [active, syncSelection]);

  useEffect(() => () => controllerRef.current.destroy(), []);

  const value = useMemo(() => ({
    preferences,
    registerPrompt,
    replay,
    setVolume,
    toggleMuted,
  }), [preferences, registerPrompt, replay, setVolume, toggleMuted]);

  return <KioskAudioContext.Provider value={value}>{children}</KioskAudioContext.Provider>;
}

function useKioskAudioPrompt(promptId) {
  const audio = useContext(KioskAudioContext);
  const registerPrompt = audio?.registerPrompt;

  useEffect(() => {
    if (!registerPrompt || !promptId) return undefined;
    return registerPrompt(promptId);
  }, [promptId, registerPrompt]);
}

function NumberPad({ onKey, onBackspace, onClear, className = '' }) {
  return (
    <div className={joinClasses('public-number-pad', 'kiosk-v4-keypad', className)} aria-label="Teclado numerico">
      {NUMBER_PAD_KEYS.map((key) => (
        <button
          key={key}
          type="button"
          className={joinClasses('public-number-key', 'kiosk-v4-key', key === 'clear' || key === 'backspace' ? 'is-command' : '')}
          aria-label={key === 'clear' ? 'Limpar' : key === 'backspace' ? 'Apagar' : key}
          onClick={() => {
            if (key === 'clear') onClear();
            else if (key === 'backspace') onBackspace();
            else onKey(key);
          }}
        >
          {key === 'clear'
            ? 'Limpar'
            : key === 'backspace'
            ? <KioskIcon icon={KioskIcons.delete} />
            : key}
        </button>
      ))}
    </div>
  );
}

export function KioskBrand({ siteName }) {
  return (
    <div className="kiosk-v4-brand" aria-label={`PREDDITA Locker - ${siteName}`}>
      <span className="kiosk-v4-brand-mark" aria-hidden="true">P</span>
      <strong className="kiosk-v4-brand-name">PREDDITA</strong>
      <span className="kiosk-v4-brand-site">Locker · {siteName}</span>
    </div>
  );
}

export function KioskAction({
  icon,
  title,
  meta,
  tone = '',
  state = 'ready',
  onClick,
}) {
  const isLoading = state === 'loading';
  const isUnavailable = state === 'unavailable';
  const actionIcon = isLoading ? KioskIcons.loading : icon;

  return (
    <button
      type="button"
      className={joinClasses(
        'kiosk-v4-action',
        tone ? `kiosk-v4-action--${tone}` : '',
        isLoading ? 'is-loading' : '',
        isUnavailable ? 'is-unavailable' : ''
      )}
      onClick={onClick}
      disabled={isLoading || isUnavailable}
      aria-busy={isLoading ? 'true' : undefined}
    >
      <span className="kiosk-v4-action-icon" aria-hidden="true">
        <KioskIcon icon={actionIcon} />
      </span>
      <span className="kiosk-v4-action-copy">
        <strong className="kiosk-v4-action-title">{title}</strong>
        <span className="kiosk-v4-action-meta">{meta}</span>
      </span>
      <KioskIcon icon={KioskIcons.arrowRight} className="kiosk-v4-action-arrow" />
    </button>
  );
}

export function KioskTopBar({ siteName, stepLabel = 'Inicio', onHelp }) {
  const audio = useContext(KioskAudioContext);
  const [isAudioOpen, setIsAudioOpen] = useState(false);
  const audioLabel = audio
    ? `Configurar audio. ${audio.preferences.muted ? 'Desativado' : 'Ativado'}`
    : 'Audio indisponivel nesta versao';

  return (
    <>
      <header className="kiosk-v4-topbar">
        <KioskBrand siteName={siteName} />
        <span className="kiosk-v4-step-label">{stepLabel}</span>
        <div className="kiosk-v4-topbar-actions">
          <button
            type="button"
            className={joinClasses('kiosk-v4-icon-button', audio ? '' : 'is-unavailable')}
            aria-label={audioLabel}
            title={audioLabel}
            disabled={!audio}
            onClick={() => setIsAudioOpen(true)}
          >
            <KioskIcon icon={audio?.preferences.muted ? KioskIcons.volumeMuted : KioskIcons.volume} />
          </button>
          <button
            type="button"
            className="kiosk-v4-icon-button"
            aria-label="Ajuda"
            title="Ajuda"
            onClick={onHelp}
          >
            <KioskIcon icon={KioskIcons.help} />
          </button>
        </div>
      </header>
      {isAudioOpen && audio ? (
        <KioskAudioDialog audio={audio} onClose={() => setIsAudioOpen(false)} />
      ) : null}
    </>
  );
}

export function KioskAudioDialog({ audio, onClose }) {
  const dialogRef = useRef(null);

  useEffect(() => {
    const previousFocus = document.activeElement;
    const getFocusable = () => [...dialogRef.current.querySelectorAll('button:not(:disabled), input:not(:disabled)')];
    getFocusable()[0]?.focus();

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      const focusable = getFocusable();
      if (event.key !== 'Tab' || focusable.length === 0) return;

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
  }, [onClose]);

  const volumePercent = Math.round(audio.preferences.volume * 100);

  return (
    <div className="kiosk-v4-audio-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="kiosk-v4-audio-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="kiosk-v4-audio-title"
      >
        <div>
          <h2 id="kiosk-v4-audio-title" className="kiosk-v4-audio-title">Orientacao sonora</h2>
          <p className="kiosk-v4-audio-copy">Instrucoes curtas acompanham cada etapa.</p>
        </div>
        <button type="button" className="kiosk-v4-audio-close" onClick={onClose} aria-label="Fechar audio" title="Fechar audio">
          <KioskIcon icon={KioskIcons.close} />
        </button>

        <label className="kiosk-v4-audio-toggle">
          <span>
            <strong>Orientacao sonora</strong>
            <small>{audio.preferences.muted ? 'Desativada' : 'Ativada'}</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={!audio.preferences.muted}
            onChange={audio.toggleMuted}
          />
        </label>

        <label className="kiosk-v4-audio-volume">
          <span>Volume</span>
          <output>{volumePercent}%</output>
          <input
            type="range"
            min={AUDIO_VOLUME_MIN * 100}
            max={AUDIO_VOLUME_MAX * 100}
            step="5"
            value={volumePercent}
            disabled={audio.preferences.muted}
            aria-label="Volume da orientacao sonora"
            onChange={(event) => audio.setVolume(Number(event.target.value) / 100)}
          />
        </label>

        <button
          type="button"
          className="kiosk-v4-audio-replay"
          onClick={audio.replay}
          disabled={audio.preferences.muted}
        >
          <KioskIcon icon={KioskIcons.volume} />
          Ouvir novamente
        </button>
        <button type="button" className="kiosk-v4-audio-confirm" onClick={onClose}>Concluir</button>
      </section>
    </div>
  );
}

export function KioskHelpDialog({ onClose }) {
  const dialogRef = useRef(null);

  useEffect(() => {
    const previousFocus = document.activeElement;
    const focusable = [...dialogRef.current.querySelectorAll('button:not(:disabled)')];
    focusable[0]?.focus();

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || focusable.length === 0) return;

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
  }, [onClose]);

  return (
    <div className="kiosk-v4-help-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="kiosk-v4-help-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="kiosk-v4-help-title"
      >
        <div>
          <h2 id="kiosk-v4-help-title" className="kiosk-v4-help-title">Precisa de ajuda?</h2>
          <p className="kiosk-v4-help-copy">Procure a portaria ou a administracao do condominio.</p>
        </div>
        <button type="button" className="kiosk-v4-help-close" onClick={onClose} aria-label="Fechar ajuda" title="Fechar ajuda">
          <KioskIcon icon={KioskIcons.close} />
        </button>
        <button type="button" className="kiosk-v4-help-confirm" onClick={onClose}>Entendi</button>
      </section>
    </div>
  );
}

export function KioskNoticeDialog({ tone = 'warn', title, text, onClose }) {
  const dialogRef = useRef(null);
  useKioskAudioPrompt(title.toLowerCase().includes('cancel') ? 'cancel' : 'error');

  useEffect(() => {
    const previousFocus = document.activeElement;
    const closeButton = dialogRef.current.querySelector('button');
    closeButton?.focus();

    const handleKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previousFocus?.focus();
    };
  }, [onClose]);

  return (
    <div className="kiosk-v4-notice-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className={joinClasses('kiosk-v4-notice', `is-${tone}`)}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="kiosk-v4-notice-title"
      >
        <KioskIcon
          icon={tone === 'danger' ? KioskIcons.warning : KioskIcons.shield}
          className="kiosk-v4-notice-icon"
        />
        <div>
          <p>{tone === 'danger' ? 'Nao foi possivel continuar' : 'Atencao necessaria'}</p>
          <h2 id="kiosk-v4-notice-title">{title}</h2>
          <strong>{text}</strong>
        </div>
        <button type="button" onClick={onClose}>Entendi</button>
      </section>
    </div>
  );
}

export function KioskFlowFrame({ siteName, stepLabel, className = '', children }) {
  const [isHelpOpen, setIsHelpOpen] = useState(false);

  return (
    <section className={joinClasses('kiosk-v4-flow', className)}>
      <KioskTopBar siteName={siteName} stepLabel={stepLabel} onHelp={() => setIsHelpOpen(true)} />
      {children}
      {isHelpOpen ? <KioskHelpDialog onClose={() => setIsHelpOpen(false)} /> : null}
    </section>
  );
}

export function PublicHome({ siteName, onCourier, onResident }) {
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  useKioskAudioPrompt('home');

  return (
    <section className="kiosk-v4-home" aria-label="Menu principal">
      <KioskTopBar siteName={siteName} onHelp={() => setIsHelpOpen(true)} />

      <main className="kiosk-v4-home-main">
        <header className="kiosk-v4-home-heading">
          <div>
            <p className="kiosk-v4-home-kicker">Bem-vindo</p>
            <h1 className="kiosk-v4-home-title">O que voce precisa fazer?</h1>
          </div>
        </header>
        <div className="kiosk-v4-home-actions">
          <KioskAction
            icon={KioskIcons.courier}
            title={PUBLIC_HOME_COPY.courierTitle}
            meta={PUBLIC_HOME_COPY.courierText}
            onClick={onCourier}
          />
          <KioskAction
            icon={KioskIcons.resident}
            title={PUBLIC_HOME_COPY.residentTitle}
            meta={PUBLIC_HOME_COPY.residentText}
            tone="resident"
            onClick={onResident}
          />
        </div>
      </main>

      <p className="kiosk-v4-home-status">Locker pronto para uso</p>
      {isHelpOpen ? <KioskHelpDialog onClose={() => setIsHelpOpen(false)} /> : null}
    </section>
  );
}

export function PublicBackButton({ onClick }) {
  return (
    <button type="button" className="public-back-button kiosk-v4-flow-back" onClick={onClick}>
      <KioskIcon icon={KioskIcons.arrowLeft} />
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
  useKioskAudioPrompt('courier-choice');

  return (
    <KioskFlowFrame
      siteName={tenantName}
      stepLabel="Entrega · Apartamento"
      className="public-kiosk-screen public-kiosk-screen--apartment kiosk-v4-flow--apartment"
    >
      <main className="kiosk-v4-flow-main kiosk-v4-flow-main--apartment">
        <header className="kiosk-v4-flow-heading">
          <div>
            <p>Entrega</p>
            <h1>{COURIER_COPY.apartmentTitle}</h1>
          </div>
          <PublicBackButton onClick={onBack} />
        </header>

        <section className="public-apartment-input kiosk-v4-apartment-entry">
          <label htmlFor="public-apartment-search">Apartamento</label>
          <input
            id="public-apartment-search"
            value={search}
            inputMode="numeric"
            placeholder="---"
            onChange={(event) => onSearchChange(event.target.value.replace(/\D/g, '').slice(0, 8))}
          />
          <NumberPad onKey={onKey} onBackspace={onBackspace} onClear={onClear} />
        </section>

        <section className="public-apartment-results kiosk-v4-apartment-results" aria-label="Apartamentos encontrados">
          <p>{recipients.length} apartamento{recipients.length === 1 ? '' : 's'} encontrado{recipients.length === 1 ? '' : 's'}</p>
          <div className="public-apartment-grid kiosk-v4-apartment-list">
            {recipients.map((recipient) => (
              <button key={recipient.id} type="button" className="public-apartment-card" onClick={() => onSelectRecipient(recipient.id)}>
                {formatRecipientApartment(recipient)}
                <KioskIcon icon={KioskIcons.arrowRight} />
              </button>
            ))}
            {recipients.length === 0 ? (
              <div className="public-empty-message kiosk-v4-empty-state">Nenhum apartamento encontrado.</div>
            ) : null}
          </div>
        </section>
      </main>
    </KioskFlowFrame>
  );
}

export function CourierConfirmStep({ tenantName, recipient, isBusy, onBack, onConfirm }) {
  useKioskAudioPrompt('courier-confirm');

  return (
    <KioskFlowFrame
      siteName={tenantName}
      stepLabel="Entrega · Confirmacao"
      className="public-kiosk-screen public-kiosk-screen--confirm kiosk-v4-flow--confirm"
    >
      <main className="kiosk-v4-flow-main kiosk-v4-flow-main--confirm">
        <header className="kiosk-v4-flow-heading">
          <div>
            <p>Confirme o destino</p>
            <h1>{COURIER_COPY.confirmTitle}</h1>
          </div>
          <PublicBackButton onClick={onBack} />
        </header>
        <div className="public-confirm-card kiosk-v4-confirm-value">
          <span>Apartamento</span>
          <strong>{recipient ? formatRecipientApartment(recipient) : 'Nao selecionado'}</strong>
        </div>
        <p className="kiosk-v4-confirm-help">{COURIER_COPY.confirmText}</p>
        <div className="public-action-bar kiosk-v4-flow-actions">
          <button type="button" className="public-secondary-button" onClick={onBack}>Corrigir</button>
          <button type="button" className="public-primary-button is-primary" onClick={onConfirm} disabled={isBusy || !recipient} aria-busy={isBusy ? 'true' : undefined}>
            {isBusy ? 'Abrindo porta...' : 'Abrir porta'}
          </button>
        </div>
      </main>
    </KioskFlowFrame>
  );
}

export function CourierDoorStep({
  tenantName,
  delivery,
  stage,
  secondsLeft,
  isBusy,
  onStored,
  onDoesNotFit,
  onCancel,
}) {
  const isCancelling = stage === 'cancelling-small-close';
  const isWaiting = stage === 'waiting-small-close' || isCancelling;
  const isLarge = stage === 'large';
  const isConfirming = stage.includes('confirming');
  useKioskAudioPrompt(isCancelling ? 'cancel' : (isWaiting || isConfirming ? 'courier-close' : 'courier-dropoff'));
  const title = isCancelling
    ? 'Feche a porta para cancelar'
    : isWaiting
    ? COURIER_COPY.waitSmallCloseTitle
    : isLarge
    ? COURIER_COPY.openLargeTitle
    : COURIER_COPY.openSmallTitle;
  const text = isCancelling
    ? 'A reserva sera apagada somente depois da confirmacao fisica de fechamento.'
    : isWaiting
    ? `${COURIER_COPY.waitSmallCloseText} Restam ${secondsLeft || 60} segundos.`
    : isLarge
    ? COURIER_COPY.openLargeText
    : COURIER_COPY.openSmallText;

  return (
    <KioskFlowFrame
      siteName={tenantName}
      stepLabel={isWaiting ? 'Entrega · Fechamento' : 'Entrega · Porta'}
      className="public-kiosk-screen public-kiosk-screen--door kiosk-v4-flow--door"
    >
      <main className="kiosk-v4-flow-main kiosk-v4-flow-main--door">
        <div className={joinClasses('kiosk-v4-door-icon', isWaiting || isConfirming ? 'is-waiting' : '')} aria-hidden="true">
          <KioskIcon icon={isWaiting || isConfirming ? KioskIcons.clock : KioskIcons.door} />
        </div>
        <div className="public-door-hero kiosk-v4-door-copy">
          <span>{title}</span>
          <strong>Porta {delivery.door}</strong>
          <p>{text}</p>
          <small>Destino: {delivery.recipientName}</small>
        </div>
        <div className="public-action-bar kiosk-v4-flow-actions kiosk-v4-flow-actions--door">
          {isWaiting ? (
            <>
              <button type="button" className="public-primary-button is-loading" disabled aria-busy="true">
                {isCancelling ? 'Aguardando porta fechar' : `Aguardando ${secondsLeft || 60}s`}
              </button>
              {!isCancelling ? (
                <button type="button" className="public-danger-button" onClick={onCancel}>Cancelar</button>
              ) : null}
            </>
          ) : isConfirming ? (
            <button type="button" className="public-primary-button is-loading" disabled aria-busy="true">Verificando fechamento</button>
          ) : (
            <>
              <button type="button" className="public-primary-button is-primary" onClick={onStored} disabled={isBusy}>Item guardado</button>
              {!isLarge ? (
                <button type="button" className="public-secondary-button" onClick={onDoesNotFit} disabled={isBusy}>Nao coube</button>
              ) : null}
            </>
          )}
        </div>
      </main>
    </KioskFlowFrame>
  );
}

export function CourierSuccessStep({ tenantName, presentation, delivery, qrImage, onNewDelivery, onHome }) {
  useKioskAudioPrompt('courier-success');

  return (
    <KioskFlowFrame
      siteName={tenantName}
      stepLabel="Entrega · Concluida"
      className="public-kiosk-screen public-kiosk-screen--success kiosk-v4-flow--success"
    >
      <main className={joinClasses('kiosk-v4-flow-main kiosk-v4-flow-main--success', presentation.shouldShowCredential ? 'has-credential' : '')}>
        <KioskIcon icon={KioskIcons.check} className="kiosk-v4-success-icon" />
        <div className="public-success-copy kiosk-v4-success-copy">
          <span>Entrega registrada</span>
          <h1>{presentation.title}</h1>
          <p>{presentation.primaryText} {presentation.secondaryText}</p>
        </div>
        {presentation.shouldShowCredential ? (
          <div className="public-success-card kiosk-v4-credential">
            <span>PIN de retirada</span>
            <strong>{delivery.pin}</strong>
            {qrImage ? <img src={qrImage} alt="QR de retirada" /> : null}
          </div>
        ) : null}
        <div className="public-action-bar kiosk-v4-flow-actions kiosk-v4-flow-actions--success">
          <button type="button" className="public-primary-button is-primary" onClick={onNewDelivery}>Nova entrega</button>
          <button type="button" className="public-secondary-button" onClick={onHome}>
            <KioskIcon icon={KioskIcons.home} />
            Inicio
          </button>
        </div>
      </main>
    </KioskFlowFrame>
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
  completedPickup,
  qrVideoRef,
  qrCanvasRef,
  onBack,
  onHome,
  onModeChange,
  onDigit,
  onClear,
  onBackspace,
  onCompletePickup,
  onStartQr,
  onStopQr,
}) {
  const audioPromptId = completedPickup
    ? 'pickup-success'
    : activePickup
    ? 'pickup-open'
    : mode === 'pin'
    ? 'pickup-pin'
    : 'pickup-qr';
  useKioskAudioPrompt(audioPromptId);

  if (completedPickup) {
    return (
      <KioskFlowFrame
        siteName={tenantName}
        stepLabel="Retirada · Concluida"
        className="public-kiosk-screen public-kiosk-screen--pickup-success kiosk-v4-flow--success"
      >
        <main className="kiosk-v4-flow-main kiosk-v4-flow-main--success">
          <KioskIcon icon={KioskIcons.check} className="kiosk-v4-success-icon" />
          <div className="public-success-copy kiosk-v4-success-copy">
            <span>Porta fechada</span>
            <h1>Retirada concluida</h1>
            <p>A encomenda foi retirada e as credenciais temporarias foram apagadas.</p>
          </div>
          <div className="public-action-bar kiosk-v4-flow-actions kiosk-v4-flow-actions--success">
            <button type="button" className="public-primary-button is-primary" onClick={onHome}>
              <KioskIcon icon={KioskIcons.home} />
              Inicio
            </button>
          </div>
        </main>
      </KioskFlowFrame>
    );
  }

  if (activePickup) {
    return (
      <KioskFlowFrame
        siteName={tenantName}
        stepLabel="Retirada · Porta"
        className="public-kiosk-screen public-kiosk-screen--pickup-open kiosk-v4-flow--door"
      >
        <main className="kiosk-v4-flow-main kiosk-v4-flow-main--door">
          <div className={joinClasses('kiosk-v4-door-icon', isBusy ? 'is-waiting' : '')} aria-hidden="true">
            <KioskIcon icon={isBusy ? KioskIcons.clock : KioskIcons.door} />
          </div>
          <div className="public-door-hero kiosk-v4-door-copy">
            <span>{isBusy ? 'Confirmando fechamento' : PICKUP_COPY.doorOpenTitle}</span>
            <strong>Porta {activePickup.door}</strong>
            <p>{PICKUP_COPY.doorOpenText}</p>
          </div>
          <div className="public-action-bar kiosk-v4-flow-actions kiosk-v4-flow-actions--door">
            <button type="button" className={joinClasses('public-primary-button is-primary', isBusy ? 'is-loading' : '')} onClick={onCompletePickup} disabled={isBusy} aria-busy={isBusy ? 'true' : undefined}>
              {isBusy ? 'Verificando fechamento' : 'Ja fechei a porta'}
            </button>
          </div>
        </main>
      </KioskFlowFrame>
    );
  }

  const isPinMode = mode === 'pin';

  return (
    <KioskFlowFrame
      siteName={tenantName}
      stepLabel={isPinMode ? 'Retirada · PIN' : 'Retirada · QR'}
      className={joinClasses('public-kiosk-screen public-kiosk-screen--pickup kiosk-v4-flow--pickup', isPinMode ? 'is-pin' : 'is-qr')}
    >
      <main className="kiosk-v4-flow-main kiosk-v4-flow-main--pickup">
        <header className="kiosk-v4-flow-heading">
          <div>
            <p>Retirada</p>
            <h1>{presentation.title}</h1>
          </div>
          <PublicBackButton onClick={onBack} />
        </header>

        <div className="kiosk-v4-mode-switch" role="tablist" aria-label="Modo de retirada">
          <button type="button" role="tab" aria-selected={isPinMode} className={isPinMode ? 'is-active' : ''} onClick={() => onModeChange('pin')}>
            PIN
          </button>
          <button type="button" role="tab" aria-selected={!isPinMode} className={!isPinMode ? 'is-active' : ''} onClick={() => onModeChange('predditaQr')}>
            QR
          </button>
        </div>

        {isPinMode ? (
          <section className="public-pin-panel kiosk-v4-pin-entry">
            <output className="public-pin-display kiosk-v4-pin-display" aria-label="PIN informado">
              {value.padEnd(6, '-').split('').map((digit, index) => (
                <span key={`${digit}-${index}`}>{digit === '-' ? '-' : '•'}</span>
              ))}
            </output>
            <NumberPad onKey={onDigit} onBackspace={onBackspace} onClear={onClear} className="public-number-pad--pin" />
            <p className="public-pin-hint" aria-live="polite">
              {isBusy
                ? 'Abrindo sua porta...'
                : presentation.canSubmit
                ? 'Conferindo o PIN automaticamente.'
                : 'Digite 6 numeros. A porta abre sozinha.'}
            </p>
          </section>
        ) : (
          <section className="public-qr-panel kiosk-v4-qr-entry">
            <div className={joinClasses('public-qr-camera kiosk-v4-qr-camera', qrScannerState.active ? 'is-active' : '')}>
              <video ref={qrVideoRef} muted playsInline />
              <canvas ref={qrCanvasRef} aria-hidden="true" />
              <KioskIcon icon={qrScannerState.active ? KioskIcons.camera : KioskIcons.qr} />
            </div>
            <p aria-live="polite">
              {qrScannerState.error || (qrScannerState.status === 'idle' ? PICKUP_COPY.qrText : qrScannerState.status)}
            </p>
            <button type="button" className="public-primary-button is-primary" onClick={qrScannerState.active ? onStopQr : onStartQr}>
              <KioskIcon icon={KioskIcons.camera} />
              {qrScannerState.active ? 'Parar camera' : 'Abrir camera'}
            </button>
          </section>
        )}
      </main>
    </KioskFlowFrame>
  );
}
