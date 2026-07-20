import React, { useState } from 'react';
import { KioskIcon, KioskIcons } from './kioskIcons.jsx';
import {
  KioskAction,
  KioskHelpDialog,
  KioskTopBar,
  PublicHome,
} from './publicKioskUi.jsx';

const PROTOTYPE_STAGES = new Set(['home', 'apartment', 'door', 'pin', 'success']);
const NUMBER_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'backspace'];

function PrototypeBackButton({ onClick }) {
  return (
    <button type="button" className="kiosk-v4-prototype-back" onClick={onClick}>
      <KioskIcon icon={KioskIcons.arrowLeft} />
      Voltar
    </button>
  );
}

function PrototypeNumberPad({ onDigit, onClear, onBackspace }) {
  return (
    <div className="kiosk-v4-prototype-keypad" aria-label="Teclado numerico do prototipo">
      {NUMBER_KEYS.map((key) => (
        <button
          key={key}
          type="button"
          className={key === 'clear' || key === 'backspace' ? 'is-command' : ''}
          aria-label={key === 'clear' ? 'Limpar' : key === 'backspace' ? 'Apagar' : key}
          onClick={() => {
            if (key === 'clear') onClear();
            else if (key === 'backspace') onBackspace();
            else onDigit(key);
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

export function KioskV4Prototype({ siteName = 'Residencial Aurora', initialStage = 'home' }) {
  const [stage, setStage] = useState(PROTOTYPE_STAGES.has(initialStage) ? initialStage : 'home');
  const [apartment, setApartment] = useState('203');
  const [pin, setPin] = useState('');
  const [isHelpOpen, setIsHelpOpen] = useState(false);

  if (stage === 'home') {
    return (
      <PublicHome
        siteName={siteName}
        onCourier={() => setStage('apartment')}
        onResident={() => setStage('pin')}
      />
    );
  }

  const stageLabels = {
    apartment: 'Entrega · Apartamento',
    door: 'Entrega · Porta',
    pin: 'Retirada · PIN',
    success: 'Entrega · Concluida',
  };

  return (
    <section className={`kiosk-v4-prototype kiosk-v4-prototype--${stage}`} aria-label="Prototipo Kiosk V4">
      <KioskTopBar siteName={siteName} stepLabel={stageLabels[stage]} onHelp={() => setIsHelpOpen(true)} />

      {stage === 'apartment' ? (
        <main className="kiosk-v4-prototype-main kiosk-v4-prototype-main--apartment">
          <header className="kiosk-v4-prototype-heading">
            <div>
              <p>Entrega</p>
              <h1>Qual e o apartamento?</h1>
            </div>
            <PrototypeBackButton onClick={() => setStage('home')} />
          </header>
          <section className="kiosk-v4-prototype-apartment-entry">
            <output aria-label="Apartamento informado">{apartment || '---'}</output>
            <PrototypeNumberPad
              onDigit={(digit) => setApartment((current) => `${current}${digit}`.slice(-4))}
              onClear={() => setApartment('')}
              onBackspace={() => setApartment((current) => current.slice(0, -1))}
            />
          </section>
          <section className="kiosk-v4-prototype-results" aria-label="Apartamentos encontrados">
            <p>Apartamento encontrado</p>
            <button type="button" onClick={() => setStage('door')}>Apartamento {apartment || '203'}</button>
          </section>
        </main>
      ) : null}

      {stage === 'door' ? (
        <main className="kiosk-v4-prototype-main kiosk-v4-prototype-main--door">
          <div className="kiosk-v4-prototype-door-icon" aria-hidden="true">
            <KioskIcon icon={KioskIcons.door} />
          </div>
          <div className="kiosk-v4-prototype-door-copy">
            <p>Porta aberta</p>
            <h1>3</h1>
            <strong>Guarde a encomenda e feche a porta.</strong>
          </div>
          <div className="kiosk-v4-prototype-actions">
            <button type="button" className="is-primary" onClick={() => setStage('success')}>Item guardado</button>
            <button type="button" onClick={() => setStage('apartment')}>Nao coube</button>
          </div>
        </main>
      ) : null}

      {stage === 'pin' ? (
        <main className="kiosk-v4-prototype-main kiosk-v4-prototype-main--pin">
          <header className="kiosk-v4-prototype-heading">
            <div>
              <p>Retirada</p>
              <h1>Digite seu PIN</h1>
            </div>
            <PrototypeBackButton onClick={() => setStage('home')} />
          </header>
          <output className="kiosk-v4-prototype-pin" aria-label="PIN informado">
            {pin.padEnd(6, '-').split('').map((digit, index) => (
              <span key={`${digit}-${index}`}>{digit === '-' ? '-' : '•'}</span>
            ))}
          </output>
          <PrototypeNumberPad
            onDigit={(digit) => setPin((current) => `${current}${digit}`.slice(0, 6))}
            onClear={() => setPin('')}
            onBackspace={() => setPin((current) => current.slice(0, -1))}
          />
        </main>
      ) : null}

      {stage === 'success' ? (
        <main className="kiosk-v4-prototype-main kiosk-v4-prototype-main--success">
          <KioskIcon icon={KioskIcons.check} className="kiosk-v4-prototype-success-icon" />
          <div>
            <p>Entrega registrada</p>
            <h1>Pronto</h1>
            <strong>O morador sera avisado.</strong>
          </div>
          <div className="kiosk-v4-prototype-actions">
            <KioskAction
              icon={KioskIcons.courier}
              title="Nova entrega"
              meta="Cadastrar outra encomenda"
              onClick={() => setStage('apartment')}
            />
            <button type="button" onClick={() => setStage('home')}>Inicio</button>
          </div>
        </main>
      ) : null}

      {isHelpOpen ? <KioskHelpDialog onClose={() => setIsHelpOpen(false)} /> : null}
    </section>
  );
}
