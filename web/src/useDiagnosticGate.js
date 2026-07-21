import { useCallback, useEffect, useRef, useState } from 'react';
import {
  endDiagnosticSession,
  getDiagnosticCredentialStatus,
  openDiagnosticProvisioning,
  verifyDiagnosticCredential,
} from './diagnosticBridge.js';

export const DIAGNOSTIC_TAPS_REQUIRED = 7;
export const DIAGNOSTIC_TAP_WINDOW_MS = 5000;
export const DIAGNOSTIC_SESSION_TIMEOUT_MS = 5 * 60 * 1000;
const ZONE_SIZE = 100;

function isInZone(event) {
  const x = event.clientX ?? event.pageX ?? 0;
  const y = event.clientY ?? event.pageY ?? 0;
  const width = typeof window !== 'undefined' ? window.innerWidth : 0;
  return x > width - ZONE_SIZE && y < ZONE_SIZE;
}

export default function useDiagnosticGate({ onEvent } = {}) {
  const [open, setOpen] = useState(false);
  const [expiresAt, setExpiresAt] = useState(0);
  const openRef = useRef(false);
  const tapsRef = useRef([]);
  const timeoutRef = useRef(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const emit = useCallback((type, reason = '') => {
    onEventRef.current?.({
      id: `diagnostic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      reason,
      at: new Date().toISOString(),
    });
  }, []);

  const clearSessionTimer = useCallback(() => {
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
  }, []);

  const close = useCallback((reason = 'user') => {
    clearSessionTimer();
    endDiagnosticSession();
    const wasOpen = openRef.current;
    openRef.current = false;
    setOpen(false);
    if (wasOpen) emit(reason === 'timeout' ? 'timeout' : 'closed', reason);
    setExpiresAt(0);
  }, [clearSessionTimer, emit]);

  const refreshSession = useCallback(() => {
    clearSessionTimer();
    const nextExpiry = Date.now() + DIAGNOSTIC_SESSION_TIMEOUT_MS;
    setExpiresAt(nextExpiry);
    timeoutRef.current = window.setTimeout(() => close('timeout'), DIAGNOSTIC_SESSION_TIMEOUT_MS);
  }, [clearSessionTimer, close]);

  useEffect(() => {
    function handleTap(event) {
      if (open) return;
      if (!isInZone(event)) {
        tapsRef.current = [];
        return;
      }

      const now = Date.now();
      tapsRef.current = [
        ...tapsRef.current.filter((timestamp) => now - timestamp < DIAGNOSTIC_TAP_WINDOW_MS),
        now,
      ];
      if (tapsRef.current.length < DIAGNOSTIC_TAPS_REQUIRED) return;
      tapsRef.current = [];

      const credential = getDiagnosticCredentialStatus();
      if (!credential.available || !credential.provisioned) {
        emit('blocked', 'credential-not-provisioned');
        window.alert('A credencial tecnica nao esta provisionada. O modo diagnostico permanece bloqueado.');
        openDiagnosticProvisioning();
        return;
      }

      const entered = window.prompt('PIN tecnico:');
      if (entered === null) return;
      if (!verifyDiagnosticCredential(entered)) {
        emit('auth-failed', 'invalid-credential');
        window.alert('Credencial tecnica invalida.');
        return;
      }

      openRef.current = true;
      setOpen(true);
      emit('opened', credential.source);
      refreshSession();
    }

    document.addEventListener('pointerdown', handleTap);
    return () => document.removeEventListener('pointerdown', handleTap);
  }, [emit, open, refreshSession]);

  useEffect(() => {
    if (!open) return undefined;
    const refresh = () => refreshSession();
    document.addEventListener('pointerdown', refresh);
    document.addEventListener('keydown', refresh);
    return () => {
      document.removeEventListener('pointerdown', refresh);
      document.removeEventListener('keydown', refresh);
    };
  }, [open, refreshSession]);

  useEffect(() => () => {
    clearSessionTimer();
    endDiagnosticSession();
  }, [clearSessionTimer]);

  return { open, expiresAt, close };
}
