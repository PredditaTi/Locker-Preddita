/**
 * Hook que abre o modo diagnostico apos uma sequencia secreta de toques
 * no canto superior direito da tela (nao visivel) seguida de senha.
 *
 * Sequencia padrao: 7 toques em <5s na regiao de 100x100px no topo direito.
 *
 * Senha: VITE_PREDDITA_DIAGNOSTIC_PIN (build-time) ou
 * localStorage 'preddita_diagnostic_pin' (runtime). Se nenhuma estiver
 * configurada, qualquer valor nao-vazio libera (apenas em dev).
 */

import { useEffect, useRef, useState } from 'react';

const TAPS_REQUIRED = 7;
const WINDOW_MS = 5000;
const ZONE_SIZE = 100;
const STORAGE_KEY = 'preddita_diagnostic_pin';

function getExpectedPin() {
  const fromBuild = String(import.meta.env?.VITE_PREDDITA_DIAGNOSTIC_PIN ?? '').trim();
  if (fromBuild) return fromBuild;
  if (typeof window !== 'undefined' && window.localStorage) {
    return String(window.localStorage.getItem(STORAGE_KEY) ?? '').trim();
  }
  return '';
}

function isInZone(event) {
  const x = event.clientX ?? event.pageX ?? 0;
  const y = event.clientY ?? event.pageY ?? 0;
  const w = typeof window !== 'undefined' ? window.innerWidth : 0;
  return x > w - ZONE_SIZE && y < ZONE_SIZE;
}

export default function useDiagnosticGate() {
  const [open, setOpen] = useState(false);
  const tapsRef = useRef([]);

  useEffect(() => {
    function handleTap(event) {
      if (!isInZone(event)) {
        tapsRef.current = [];
        return;
      }
      const now = Date.now();
      tapsRef.current = [...tapsRef.current.filter((t) => now - t < WINDOW_MS), now];
      if (tapsRef.current.length < TAPS_REQUIRED) return;
      tapsRef.current = [];

      const expected = getExpectedPin();
      const entered = window.prompt(
        expected
          ? 'Senha do diagnostico:'
          : 'Modo diagnostico (sem PIN configurado — qualquer texto libera):',
      );
      if (entered === null) return;
      if (!expected || entered === expected) {
        setOpen(true);
      } else {
        window.alert('Senha incorreta.');
      }
    }

    document.addEventListener('pointerdown', handleTap);
    return () => document.removeEventListener('pointerdown', handleTap);
  }, []);

  return {
    open,
    close: () => setOpen(false),
    // expor para teste manual no console se precisar
    forceOpen: () => setOpen(true),
  };
}
