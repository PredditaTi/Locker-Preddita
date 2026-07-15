# Public Kiosk Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the public locker experience so delivery and pickup feel like a self-service ATM: one decision per screen, one dominant action, no technical language, no crowded dashboards.

**Architecture:** Keep the working locker logic in place and replace only the public presentation layer for `home`, `courier`, and `resident`. Extract public UI components into a dedicated file, keep hardware actions inside `App.jsx`, and add small presenter helpers in `touchFlow.js` so the public UX can be tested without a browser.

**Tech Stack:** React 18, Vite, plain CSS, Android WebView assets, Node-based workflow tests, ADB install flow.

---

## Current Constraints

- The physical panel is effectively `1024x600` landscape and must not depend on page scroll.
- The public user is not technical. Avoid: `sensor`, `RS-485`, `board`, `bridge`, `sem leitura`, `serial`, `payload`, `sync`.
- Public delivery flow must preserve the current rule: apartment click opens a small door first.
- If the item does not fit, the user closes the small door, then the app opens a large door.
- The large doors for this locker are doors `1` and `2`; other doors are small.
- Existing business logic for doors, offline events, email queue, PIN/QR generation, and admin panel must remain intact.
- The admin/system screens can stay visually denser because they are operator tools, not public kiosk screens.

## Target Public Flow

### Home

Two full-height buttons only:

- `Entregar encomenda`
- `Retirar encomenda`

No admin button on the public home. Admin remains reachable from the protected/admin flow already present in the app.

### Delivery

1. Screen: `Digite o apartamento`.
2. User types digits with a large keypad or touches a visible apartment result.
3. Screen: `Apartamento correto?` with two buttons: `Corrigir` and `Abrir porta`.
4. App opens the smallest available small door.
5. Screen: `Porta X aberta` with two actions:
   - `Item guardado`
   - `Nao coube`
6. If `Item guardado`, wait for door closed, register delivery, return to home.
7. If `Nao coube`, show `Feche a porta pequena`.
8. After the small door closes, open a large door.
9. Screen: `Porta X aberta` with only `Item guardado`.
10. Success screen returns automatically when email exists. If no email exists, keep PIN visible until manual action.

### Pickup

1. Screen: `Digite seu PIN`.
2. Numeric keypad dominates the screen.
3. QR is visible as a secondary option: `Ler QR`.
4. Completing 6 digits automatically validates and opens when valid.
5. Door-open screen says: `Retire a encomenda e feche a porta`.
6. Button: `Ja fechei a porta`.
7. After physical close confirmation, return to home.

---

## File Structure

### Create

- `web/src/publicKioskCopy.js`
  - Owns public-facing text labels and avoids scattered copy in `App.jsx`.

- `web/src/publicKioskUi.jsx`
  - Owns public-only React components.
  - Receives state and handlers from `App.jsx`.
  - Does not call serial, remote APIs, localStorage, or hardware methods.

### Modify

- `web/src/App.jsx`
  - Keep business handlers.
  - Replace public JSX blocks with component calls.
  - Keep admin, doors, system screens as they are.

- `web/src/app.css`
  - Add a dedicated `Public Kiosk V3` section.
  - Avoid breaking admin classes.
  - Keep public classes namespaced with `.public-kiosk-*`.

- `web/src/touchFlow.js`
  - Add presenter helpers that can be unit-tested.

- `scripts/v2-workflow-test.mjs`
  - Add tests for the public presentation rules and pickup auto-open readiness.

### Optional Backup Artifact

- `backups/app-before-public-kiosk-v3.apk`
  - Use only during deployment to keep a quick rollback APK.

---

## Task 1: Add Public UX Presenter Tests

**Files:**

- Modify: `scripts/v2-workflow-test.mjs`
- Modify: `web/src/touchFlow.js`

- [ ] **Step 1: Write failing tests for public success disclosure**

Add this import in `scripts/v2-workflow-test.mjs`:

```js
import {
  applyBackspaceKey,
  applyDigitKey,
  getCourierSuccessPresentation,
  getPickupEntryPresentation,
  isCompletePin,
  isDoorClosedForCompletion,
  shouldShowCourierPickupCredential,
} from '../web/src/touchFlow.js';
```

Add these assertions after the existing `shouldShowCourierPickupCredential` assertions:

```js
assert.deepEqual(
  getCourierSuccessPresentation({ recipientEmail: 'morador@example.com', pin: '123456' }),
  {
    title: 'Pronto',
    shouldShowCredential: false,
    primaryText: 'A encomenda ficou registrada.',
    secondaryText: 'O morador recebera o codigo quando o armario sincronizar.',
    autoReturn: true,
  },
  'sucesso com e-mail deve esconder PIN/QR e voltar automaticamente'
);

assert.deepEqual(
  getCourierSuccessPresentation({ recipientEmail: '', pin: '123456' }),
  {
    title: 'Anote o PIN',
    shouldShowCredential: true,
    primaryText: 'A encomenda ficou registrada.',
    secondaryText: 'Este apartamento nao tem e-mail cadastrado.',
    autoReturn: false,
  },
  'sucesso sem e-mail deve manter PIN/QR visiveis'
);

assert.deepEqual(
  getPickupEntryPresentation('pin', '12345'),
  {
    title: 'Digite seu PIN',
    helper: 'Digite os 6 numeros recebidos.',
    canSubmit: false,
    shouldAutoSubmit: false,
  },
  'PIN incompleto nao deve tentar abrir'
);

assert.deepEqual(
  getPickupEntryPresentation('pin', '123456'),
  {
    title: 'Abrindo sua porta',
    helper: 'Conferindo o codigo recebido.',
    canSubmit: true,
    shouldAutoSubmit: true,
  },
  'PIN completo deve validar automaticamente'
);
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```powershell
node scripts/v2-workflow-test.mjs
```

Expected failure:

```text
SyntaxError: The requested module '../web/src/touchFlow.js' does not provide an export named 'getCourierSuccessPresentation'
```

- [ ] **Step 3: Implement the presenter helpers**

Add to `web/src/touchFlow.js`:

```js
export function getCourierSuccessPresentation(delivery) {
  const shouldShowCredential = shouldShowCourierPickupCredential(delivery);

  return {
    title: shouldShowCredential ? 'Anote o PIN' : 'Pronto',
    shouldShowCredential,
    primaryText: 'A encomenda ficou registrada.',
    secondaryText: shouldShowCredential
      ? 'Este apartamento nao tem e-mail cadastrado.'
      : 'O morador recebera o codigo quando o armario sincronizar.',
    autoReturn: !shouldShowCredential,
  };
}

export function getPickupEntryPresentation(mode, value) {
  const isPinMode = mode === 'pin';
  const canSubmit = isPinMode ? isCompletePin(value) : String(value ?? '').trim().length >= 6;

  return {
    title: isPinMode && canSubmit ? 'Abrindo sua porta' : isPinMode ? 'Digite seu PIN' : 'Leia o QR',
    helper: isPinMode && canSubmit
      ? 'Conferindo o codigo recebido.'
      : isPinMode
      ? 'Digite os 6 numeros recebidos.'
      : 'Aponte o QR recebido para a camera.',
    canSubmit,
    shouldAutoSubmit: isPinMode && canSubmit,
  };
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run:

```powershell
node scripts/v2-workflow-test.mjs
```

Expected:

```text
PREDDITA_V2_WORKFLOW_OK
```

---

## Task 2: Create Public Copy Module

**Files:**

- Create: `web/src/publicKioskCopy.js`

- [ ] **Step 1: Create copy constants**

Create `web/src/publicKioskCopy.js`:

```js
export const PUBLIC_HOME_COPY = {
  courierTitle: 'Entregar encomenda',
  courierText: 'Guardar uma entrega no armario',
  residentTitle: 'Retirar encomenda',
  residentText: 'Abrir com PIN ou QR',
};

export const COURIER_COPY = {
  apartmentTitle: 'Digite o apartamento',
  apartmentSubtitle: 'Toque no apartamento correto para continuar.',
  confirmTitle: 'Apartamento correto?',
  confirmText: 'Ao confirmar, uma porta pequena sera aberta.',
  openSmallTitle: 'Porta aberta',
  openSmallText: 'Guarde a encomenda. Se nao couber, toque em Nao coube.',
  waitSmallCloseTitle: 'Feche a porta pequena',
  waitSmallCloseText: 'A porta grande sera aberta depois que a pequena for fechada.',
  openLargeTitle: 'Porta grande aberta',
  openLargeText: 'Guarde a encomenda e toque em Item guardado.',
};

export const PICKUP_COPY = {
  title: 'Digite seu PIN',
  subtitle: 'Use os 6 numeros recebidos para abrir a porta.',
  qrTitle: 'Ler QR',
  qrText: 'Aponte o QR recebido para a camera.',
  doorOpenTitle: 'Porta aberta',
  doorOpenText: 'Retire a encomenda, feche a porta e confirme.',
};
```

- [ ] **Step 2: Run syntax check through import**

Run:

```powershell
node -e "import('./web/src/publicKioskCopy.js').then(() => console.log('PUBLIC_COPY_OK'))"
```

Expected:

```text
PUBLIC_COPY_OK
```

---

## Task 3: Create Public UI Components

**Files:**

- Create: `web/src/publicKioskUi.jsx`

- [ ] **Step 1: Create component file with no hardware side effects**

Create `web/src/publicKioskUi.jsx`:

```jsx
import React from 'react';
import { formatRecipientApartment } from './lockerWorkflow.js';
import { joinClasses } from './appUi.jsx';
import { COURIER_COPY, PICKUP_COPY, PUBLIC_HOME_COPY } from './publicKioskCopy.js';

export function PublicHome({ onCourier, onResident }) {
  return (
    <section className="public-kiosk-home" aria-label="Menu principal">
      <button type="button" className="public-home-action is-courier" onClick={onCourier}>
        <span className="public-home-icon" aria-hidden="true">BOX</span>
        <strong>{PUBLIC_HOME_COPY.courierTitle}</strong>
        <span>{PUBLIC_HOME_COPY.courierText}</span>
      </button>
      <button type="button" className="public-home-action is-resident" onClick={onResident}>
        <span className="public-home-icon" aria-hidden="true">PIN</span>
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
          <div className="public-number-pad" aria-label="Teclado do apartamento">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'backspace'].map((key) => (
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
  onValidate,
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
          <div className="public-number-pad public-number-pad--pin">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'backspace'].map((key) => (
              <button
                key={key}
                type="button"
                className={joinClasses('public-number-key', key === 'clear' || key === 'backspace' ? 'is-muted' : '')}
                onClick={() => {
                  if (key === 'clear') onClear();
                  else if (key === 'backspace') onBackspace();
                  else onDigit(key);
                }}
              >
                {key === 'clear' ? 'Limpar' : key === 'backspace' ? 'Apagar' : key}
              </button>
            ))}
          </div>
          <button type="button" className="public-primary-button" onClick={onValidate} disabled={isBusy || !presentation.canSubmit}>
            {isBusy ? 'Abrindo...' : 'Abrir porta'}
          </button>
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
```

- [ ] **Step 2: Run syntax check through Vite build later**

Do not run build yet. This component references existing app props that will be wired in Task 4.

---

## Task 4: Wire Public Components Into App

**Files:**

- Modify: `web/src/App.jsx`

- [ ] **Step 1: Add imports**

Add near the other local imports:

```js
import {
  CourierApartmentStep,
  CourierConfirmStep,
  CourierDoorStep,
  CourierSuccessStep,
  PublicHome,
  ResidentPickupStep,
} from './publicKioskUi.jsx';
```

Update the `touchFlow.js` import:

```js
import {
  applyBackspaceKey,
  applyDigitKey,
  getCourierSuccessPresentation,
  getPickupEntryPresentation,
  isCompletePin,
  isDoorClosedForCompletion,
  shouldShowCourierPickupCredential,
} from './touchFlow.js';
```

- [ ] **Step 2: Add derived public presentation values**

Add after `const isPickupCodeReady = ...`:

```js
const courierSuccessPresentation = courierSuccessDelivery
  ? getCourierSuccessPresentation(courierSuccessDelivery)
  : null;
const pickupEntryPresentation = getPickupEntryPresentation(pickupMode, pickupValue);
```

- [ ] **Step 3: Replace the home JSX**

Replace the current `view === 'home'` block with:

```jsx
{view === 'home' ? (
  <PublicHome onCourier={openCourierFlow} onResident={openResidentFlow} />
) : null}
```

- [ ] **Step 4: Replace courier success JSX**

Replace the `view === 'courier' && courierStep === 'success' && courierSuccessDelivery` branch with:

```jsx
{view === 'courier' && courierStep === 'success' && courierSuccessDelivery && courierSuccessPresentation ? (
  <CourierSuccessStep
    presentation={courierSuccessPresentation}
    delivery={courierSuccessDelivery}
    qrImage={qrImage}
    onNewDelivery={openCourierFlow}
    onHome={finishCourierSuccessNow}
  />
) : view === 'courier' && activeDeposit ? (
  ...
) : (
  ...
)}
```

- [ ] **Step 5: Replace courier active-door JSX**

Replace the public dropoff branch with:

```jsx
<CourierDoorStep
  delivery={activeDeposit}
  stage={courierDepositStage}
  secondsLeft={smallCloseSecondsLeft}
  isBusy={isBusy}
  onStored={handleConfirmDeposit}
  onDoesNotFit={handleUseLargeDoor}
  onCancel={handleCancelWaitingForLargeDoor}
/>
```

- [ ] **Step 6: Replace courier apartment step JSX**

Replace the courier recipient selection branch with:

```jsx
{view === 'courier' && courierStep === 'recipient' ? (
  <CourierApartmentStep
    tenantName={lockerState.tenant.siteName}
    search={recipientSearch}
    recipients={filteredRecipients}
    onSearchChange={setRecipientSearch}
    onKey={handleApartmentKey}
    onBackspace={handleApartmentBackspace}
    onClear={() => setRecipientSearch('')}
    onSelectRecipient={handleSelectRecipient}
    onBack={() => {
      resetCourierFlow();
      setView('home');
    }}
  />
) : null}
```

- [ ] **Step 7: Replace courier confirm JSX**

Replace the courier confirm branch with:

```jsx
{view === 'courier' && courierStep === 'confirm' && selectedRecipient ? (
  <CourierConfirmStep
    tenantName={lockerState.tenant.siteName}
    recipient={selectedRecipient}
    isBusy={isBusy}
    onBack={handleBackToApartmentList}
    onConfirm={handleConfirmCourierRecipient}
  />
) : null}
```

- [ ] **Step 8: Replace resident public JSX**

Replace the `view === 'resident' ? (...) : (...)` branch content with:

```jsx
{view === 'resident' ? (
  <ResidentPickupStep
    tenantName={lockerState.tenant.siteName}
    mode={pickupMode}
    value={pickupValue}
    presentation={pickupEntryPresentation}
    isBusy={isBusy}
    qrScannerState={qrScannerState}
    activePickup={activePickup}
    qrVideoRef={qrVideoRef}
    qrCanvasRef={qrCanvasRef}
    onBack={() => {
      stopQrScanner();
      setPickupValue('');
      setActivePickupId('');
      setView('home');
    }}
    onModeChange={(mode) => {
      stopQrScanner();
      pickupAutoSubmitRef.current = '';
      setPickupMode(mode);
      setPickupValue('');
      setActivePickupId('');
    }}
    onDigit={handlePickupDigit}
    onClear={handlePickupClear}
    onBackspace={handlePickupBackspace}
    onValidate={handleValidatePickup}
    onCompletePickup={handleCompletePickup}
    onStartQr={startQrScanner}
    onStopQr={stopQrScanner}
  />
) : (
  <div className="operation-grid operation-grid--split">
    ...keep existing adminPickup JSX...
  </div>
)}
```

- [ ] **Step 9: Run JSX syntax check through build**

Run:

```powershell
Push-Location web
npm run build
Pop-Location
```

Expected:

```text
✓ built
```

---

## Task 5: Add Public Kiosk V3 CSS

**Files:**

- Modify: `web/src/app.css`

- [ ] **Step 1: Add the public CSS block before diagnostics**

Add this section above the diagnostics comment:

```css
/* ===========================================================================
 * Public Kiosk V3
 * =========================================================================== */
.public-kiosk-home,
.public-kiosk-screen {
  height: 100%;
  min-height: 0;
}

.public-kiosk-home {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 20px;
}

.public-home-action {
  min-height: 0;
  padding: 34px;
  border-radius: 34px;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 22px;
  text-align: center;
  background: linear-gradient(180deg, #ffffff, #edf7ff);
  border: 1px solid rgba(5, 135, 255, 0.18);
  box-shadow: 0 24px 54px rgba(6, 27, 49, 0.1);
  color: var(--brand-navy);
}

.public-home-action.is-resident {
  background: linear-gradient(180deg, #ffffff, #fff5df);
  border-color: rgba(255, 179, 71, 0.28);
}

.public-home-icon {
  width: 126px;
  height: 126px;
  border-radius: 38px;
  display: grid;
  place-items: center;
  color: #ffffff;
  font-size: 1.8rem;
  font-weight: 1000;
  letter-spacing: -0.04em;
  background: linear-gradient(180deg, #0bb7ff, #004ea8);
}

.public-home-action.is-resident .public-home-icon {
  color: #102238;
  background: linear-gradient(180deg, #ffca6a, #f2a22d);
}

.public-home-action strong {
  max-width: 390px;
  font-size: clamp(2.7rem, 5vw, 4.8rem);
  line-height: 0.9;
  letter-spacing: -0.075em;
}

.public-home-action span:last-child {
  max-width: 360px;
  color: var(--muted);
  font-size: 1.34rem;
  font-weight: 850;
}

.public-kiosk-screen {
  padding: 16px;
  border-radius: 32px;
  background: rgba(255, 255, 255, 0.9);
  border: 1px solid var(--line);
  display: grid;
  gap: 14px;
  overflow: hidden;
}

.public-kiosk-header {
  min-height: 92px;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.public-kiosk-site {
  display: block;
  margin-bottom: 4px;
  color: var(--accent-dark);
  font-size: 0.74rem;
  font-weight: 1000;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}

.public-kiosk-header h1 {
  margin: 0;
  color: var(--brand-navy);
  font-size: clamp(2.45rem, 4.8vw, 4.2rem);
  line-height: 0.9;
  letter-spacing: -0.07em;
}

.public-kiosk-header p {
  margin: 8px 0 0;
  color: var(--muted);
  font-size: 1.12rem;
  font-weight: 800;
}

.public-back-button,
.public-secondary-button,
.public-primary-button,
.public-danger-button {
  min-height: 78px;
  border-radius: 26px;
  padding: 0 26px;
  font-size: 1.2rem;
  font-weight: 1000;
}

.public-back-button,
.public-secondary-button {
  background: #ffffff;
  border: 1px solid rgba(5, 135, 255, 0.16);
  color: var(--brand-navy);
}

.public-primary-button {
  background: linear-gradient(180deg, #0bb7ff, #004ea8);
  color: #ffffff;
  box-shadow: 0 18px 34px rgba(5, 135, 255, 0.22);
}

.public-danger-button {
  background: linear-gradient(180deg, #ff7b83, #c83242);
  color: #ffffff;
}

.public-primary-button:disabled,
.public-secondary-button:disabled,
.public-danger-button:disabled {
  opacity: 0.58;
}

.public-apartment-layout,
.public-pickup-layout {
  min-height: 0;
  display: grid;
  gap: 14px;
}

.public-apartment-layout {
  grid-template-columns: minmax(300px, 0.42fr) minmax(0, 0.58fr);
}

.public-apartment-input,
.public-apartment-results,
.public-pin-panel,
.public-qr-panel,
.public-confirm-card,
.public-door-hero,
.public-door-details,
.public-success-copy,
.public-success-card {
  min-height: 0;
  padding: 18px;
  border-radius: 30px;
  background: rgba(255, 255, 255, 0.92);
  border: 1px solid rgba(5, 135, 255, 0.14);
}

.public-apartment-input {
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  gap: 10px;
}

.public-apartment-input label {
  color: var(--muted);
  font-size: 0.82rem;
  font-weight: 1000;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.public-apartment-input input,
.public-pin-display {
  min-height: 86px;
  border-radius: 28px;
  border: 1px solid rgba(5, 135, 255, 0.18);
  background: #ffffff;
  color: var(--brand-navy);
  text-align: center;
  font-size: clamp(2.4rem, 5vw, 4.4rem);
  font-weight: 1000;
  letter-spacing: 0.12em;
}

.public-number-pad {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.public-number-key {
  min-height: 66px;
  border-radius: 22px;
  color: var(--brand-navy);
  background: linear-gradient(180deg, #ffffff, #edf7ff);
  border: 1px solid rgba(5, 135, 255, 0.16);
  font-size: 1.65rem;
  font-weight: 1000;
}

.public-number-key.is-muted {
  font-size: 1rem;
  color: #42637f;
  background: #ffffff;
}

.public-apartment-results {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 10px;
}

.public-result-count {
  color: var(--muted);
  font-size: 0.9rem;
  font-weight: 950;
}

.public-apartment-grid {
  min-height: 0;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-content: start;
  gap: 10px;
  overflow: hidden;
}

.public-apartment-card {
  min-height: 92px;
  border-radius: 26px;
  background: linear-gradient(180deg, #ffffff, #f3fbff);
  border: 1px solid rgba(5, 135, 255, 0.16);
  color: var(--brand-navy);
  font-size: clamp(1.35rem, 2.2vw, 2rem);
  font-weight: 1000;
}

.public-empty-message {
  grid-column: 1 / -1;
  display: grid;
  place-items: center;
  min-height: 180px;
  color: var(--muted);
  font-size: 1.25rem;
  font-weight: 900;
}

.public-action-bar {
  min-height: 0;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.public-kiosk-screen--confirm,
.public-kiosk-screen--door,
.public-kiosk-screen--success,
.public-kiosk-screen--pickup-open {
  grid-template-rows: auto minmax(0, 1fr) auto;
}

.public-confirm-card,
.public-door-hero,
.public-success-copy {
  display: grid;
  place-items: center;
  align-content: center;
  text-align: center;
  gap: 12px;
}

.public-confirm-card span,
.public-door-hero span,
.public-success-copy span,
.public-success-card span,
.public-door-details span {
  color: var(--muted);
  font-size: 0.82rem;
  font-weight: 1000;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.public-confirm-card strong,
.public-door-hero strong,
.public-success-copy h1,
.public-success-card strong {
  margin: 0;
  color: var(--brand-navy);
  font-size: clamp(3rem, 7vw, 6.8rem);
  line-height: 0.88;
  letter-spacing: -0.07em;
}

.public-door-hero p,
.public-success-copy p,
.public-success-card p {
  max-width: 560px;
  margin: 0;
  color: var(--muted);
  font-size: 1.25rem;
  font-weight: 850;
  line-height: 1.25;
}

.public-door-details {
  display: grid;
  align-content: center;
  gap: 8px;
}

.public-door-details strong {
  color: var(--brand-navy);
  font-size: 2rem;
  line-height: 1;
}

.public-pickup-layout {
  grid-template-columns: minmax(0, 1.22fr) minmax(260px, 0.78fr);
}

.public-pin-panel,
.public-qr-panel,
.public-success-card {
  display: grid;
  align-content: center;
  gap: 12px;
}

.public-number-pad--pin .public-number-key {
  min-height: 72px;
}

.public-qr-camera {
  min-height: 240px;
  border-radius: 26px;
  overflow: hidden;
  display: grid;
  place-items: center;
  padding: 14px;
  background: linear-gradient(135deg, #061b31, #0057b8);
  color: #ffffff;
  text-align: center;
  font-weight: 850;
}

.public-qr-camera video {
  width: 100%;
  height: 170px;
  object-fit: cover;
  border-radius: 18px;
}

.public-qr-camera canvas {
  display: none;
}

.public-success-card {
  justify-items: center;
  text-align: center;
}

.public-success-card img {
  width: 190px;
  height: 190px;
  padding: 10px;
  border-radius: 20px;
  background: #ffffff;
  border: 1px solid rgba(5, 135, 255, 0.16);
}

@media (max-width: 900px) {
  .public-home-action strong {
    font-size: 3.2rem;
  }

  .public-apartment-layout,
  .public-pickup-layout {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }

  .public-apartment-card {
    min-height: 82px;
    font-size: 1.35rem;
  }
}
```

- [ ] **Step 2: Verify no class name collision**

Run:

```powershell
Select-String -Path web\src\app.css -Pattern "public-kiosk|public-home|public-apartment|public-pickup" | Measure-Object
```

Expected:

```text
Count greater than 50
```

---

## Task 6: Remove Public Technical Language From App JSX

**Files:**

- Modify: `web/src/App.jsx`

- [ ] **Step 1: Search for technical words in public areas**

Run:

```powershell
Select-String -Path web\src\App.jsx -Pattern "sensor|Serial|RS-485|Bridge|Board|payload|sem leitura|sincronizando" -CaseSensitive:$false
```

Expected:

```text
Matches are allowed in admin, doors, system, diagnostics, and hardware functions.
Matches must not appear inside the JSX passed to PublicHome, CourierApartmentStep, CourierConfirmStep, CourierDoorStep, CourierSuccessStep, or ResidentPickupStep.
```

- [ ] **Step 2: Replace public banner text**

Keep error details for operators in audit/logs, but public banners should use:

```js
setBanner({
  tone: 'warn',
  title: 'Nao foi possivel abrir',
  text: 'Tente novamente. Se a porta nao abrir, procure a administracao.',
});
```

For door-close timeout in public delivery:

```js
setBanner({
  tone: 'warn',
  title: 'Feche a porta',
  text: `Feche a porta ${deliveryToConfirm.door} e toque em Item guardado novamente.`,
});
```

For no small door:

```js
setBanner({
  tone: 'warn',
  title: 'Sem porta disponivel',
  text: 'Nao ha porta pequena livre agora. Procure a administracao.',
});
```

For no large door:

```js
setBanner({
  tone: 'warn',
  title: 'Sem porta grande',
  text: 'As portas grandes estao ocupadas agora. Guarde na porta aberta ou procure a administracao.',
});
```

- [ ] **Step 3: Run workflow test**

Run:

```powershell
node scripts/v2-workflow-test.mjs
```

Expected:

```text
PREDDITA_V2_WORKFLOW_OK
```

---

## Task 7: Browser QA at Locker Size

**Files:**

- No code files unless QA finds layout problems.

- [ ] **Step 1: Start or reuse local web server**

Run:

```powershell
try { (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:5174" -TimeoutSec 3).StatusCode } catch { $_.Exception.Message }
```

Expected when server is already running:

```text
200
```

If not running:

```powershell
Push-Location web
npm run dev -- --host 0.0.0.0 --port 5174
```

- [ ] **Step 2: Verify home at 1024x600**

Use Browser viewport `1024x600` and navigate to:

```text
http://127.0.0.1:5174/
```

Expected:

- No vertical body overflow.
- Two home buttons fill the screen.
- Each button is at least `420px` wide and `480px` tall.
- No admin/system wording visible.

- [ ] **Step 3: Verify delivery apartment screen**

Click `Entregar encomenda`.

Expected:

- Header visible.
- Apartment input visible.
- Numeric keypad visible.
- At least 4 apartment cards visible without scrolling.
- No page/body overflow.
- No technical text.

- [ ] **Step 4: Verify delivery confirm screen**

Click one apartment.

Expected:

- Screen title says `Apartamento correto?`.
- Apartment number is the largest text on screen.
- Buttons visible: `Corrigir`, `Abrir porta`.
- No package size selector visible.

- [ ] **Step 5: Verify pickup screen**

Return home and click `Retirar encomenda`.

Expected:

- PIN display is visually dominant.
- Numeric keypad buttons are at least `60px` tall.
- QR panel is secondary.
- No page/body overflow.

- [ ] **Step 6: Verify console**

Read browser console errors.

Expected:

```text
[]
```

---

## Task 8: Full Verification

**Files:**

- No code files unless verification fails.

- [ ] **Step 1: Run full project verification**

Run from project root:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\v2-verify.ps1
```

Expected:

```text
PREDDITA_V2_WORKFLOW_OK
PREDDITA_V2_QR_SCANNER_OK
PREDDITA_V2_SMOKE_OK
PREDDITA_V2_POSTGRES_SMOKE_SKIPPED
found 0 vulnerabilities
✓ built
Verificacao concluida com sucesso.
```

- [ ] **Step 2: Confirm Android assets changed**

Run:

```powershell
Get-ChildItem android\app\src\main\assets\www\assets | Sort-Object LastWriteTime -Descending | Select-Object -First 4 Name,LastWriteTime
```

Expected:

```text
Newest CSS and JS bundles have the current timestamp.
```

---

## Task 9: Build APK and Install With Rollback Safety

**Files:**

- Creates optional backup file: `backups/app-before-public-kiosk-v3.apk`

- [ ] **Step 1: Confirm ADB device**

Run:

```powershell
& "C:\Users\Usuario\Desktop\platform-tools\adb.exe" devices -l
```

Expected:

```text
192.168.0.64:5555      device product:rk3562_t model:KS1062_N_ZY
```

- [ ] **Step 2: Backup current installed APK**

Run:

```powershell
New-Item -ItemType Directory -Force -Path backups
$apkPath = (& "C:\Users\Usuario\Desktop\platform-tools\adb.exe" -s 192.168.0.64:5555 shell pm path com.preddita.entregaslocker).Replace("package:", "").Trim()
& "C:\Users\Usuario\Desktop\platform-tools\adb.exe" -s 192.168.0.64:5555 pull $apkPath "backups\app-before-public-kiosk-v3.apk"
```

Expected:

```text
1 file pulled
```

- [ ] **Step 3: Build release APK**

Run:

```powershell
Push-Location android
.\gradlew.bat assembleRelease
Pop-Location
```

Expected:

```text
BUILD SUCCESSFUL
```

- [ ] **Step 4: Install APK**

Run:

```powershell
& "C:\Users\Usuario\Desktop\platform-tools\adb.exe" -s 192.168.0.64:5555 install -r "C:\Users\Usuario\Documents\App armário preddita\preddita-entregas-retiradas-v2\android\app\build\outputs\apk\release\app-release.apk"
```

Expected:

```text
Success
```

- [ ] **Step 5: Open app on locker**

Run:

```powershell
& "C:\Users\Usuario\Desktop\platform-tools\adb.exe" -s 192.168.0.64:5555 shell monkey -p com.preddita.entregaslocker -c android.intent.category.LAUNCHER 1
```

Expected:

```text
Events injected: 1
```

- [ ] **Step 6: Confirm app focus**

Run:

```powershell
& "C:\Users\Usuario\Desktop\platform-tools\adb.exe" -s 192.168.0.64:5555 shell dumpsys window | Select-String -Pattern "mCurrentFocus|mFocusedApp|com.preddita.entregaslocker" | Select-Object -First 10
```

Expected:

```text
mCurrentFocus=Window{... com.preddita.entregaslocker/com.preddita.entregaslocker.MainActivity}
mFocusedApp=ActivityRecord{... com.preddita.entregaslocker/.MainActivity}
```

---

## Task 10: Physical Locker Acceptance Test

**Files:**

- No code files unless physical testing finds a bug.

- [ ] **Step 1: Test delivery with item that fits small door**

On the locker:

1. Tap `Entregar encomenda`.
2. Enter an apartment.
3. Tap apartment result.
4. Tap `Abrir porta`.
5. Confirm a small door opens.
6. Put an item in.
7. Close the door.
8. Tap `Item guardado`.

Expected:

- Delivery is registered.
- Success screen appears.
- App returns home automatically when email exists.
- Panel receives delivery when network is available, or event remains queued offline.

- [ ] **Step 2: Test delivery with item that does not fit**

On the locker:

1. Tap `Entregar encomenda`.
2. Enter an apartment.
3. Tap apartment result.
4. Tap `Abrir porta`.
5. When small door opens, tap `Nao coube`.
6. Close the small door.
7. Confirm a large door opens.
8. Put item in large door.
9. Close large door.
10. Tap `Item guardado`.

Expected:

- Small reservation is cancelled.
- Large door is reserved.
- Delivery is registered against large door.
- App returns home after success.

- [ ] **Step 3: Test pickup with PIN**

On the locker:

1. Tap `Retirar encomenda`.
2. Enter a valid 6-digit PIN.

Expected:

- App validates automatically after 6 digits.
- Correct door opens.
- Screen asks user to retrieve and close door.
- After close and confirmation, delivery becomes collected and door becomes free.

- [ ] **Step 4: Test no available large door**

Prepare both large doors as occupied.

On the locker:

1. Start delivery.
2. Open small door.
3. Tap `Nao coube`.

Expected:

- App shows popup `Sem porta grande`.
- No confusing silent failure.
- Small-door path remains recoverable.

---

## Rollback

If the public UI is worse on the real panel:

```powershell
& "C:\Users\Usuario\Desktop\platform-tools\adb.exe" -s 192.168.0.64:5555 install -r "C:\Users\Usuario\Documents\App armário preddita\preddita-entregas-retiradas-v2\backups\app-before-public-kiosk-v3.apk"
& "C:\Users\Usuario\Desktop\platform-tools\adb.exe" -s 192.168.0.64:5555 shell monkey -p com.preddita.entregaslocker -c android.intent.category.LAUNCHER 1
```

Expected:

```text
Success
Events injected: 1
```

---

## Self-Review

**Spec coverage:** Covered home, delivery, pickup, small-to-large fallback, email/no-email success, no technical public language, browser QA, full tests, APK install, and physical acceptance.

**Placeholder scan:** No task uses vague implementation language like `TBD`, `TODO`, or unspecified error handling. Each code step includes concrete snippets or exact commands.

**Type consistency:** The plan defines `getCourierSuccessPresentation`, `getPickupEntryPresentation`, `CourierApartmentStep`, `CourierConfirmStep`, `CourierDoorStep`, `CourierSuccessStep`, `ResidentPickupStep`, and uses the same names in later tasks.
