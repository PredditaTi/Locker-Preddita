export const AUDIO_PREFERENCE_STORAGE_KEY = 'preddita_kiosk_audio_preferences_v1';
export const AUDIO_VOLUME_MIN = 0.2;
export const AUDIO_VOLUME_MAX = 0.65;

const DEFAULT_PREFERENCES = Object.freeze({
  muted: true,
  volume: 0.45,
});

export const AUDIO_PROMPTS = Object.freeze({
  home: Object.freeze({
    source: new URL('./assets/audio/home.m4a', import.meta.url).href,
    transcript: 'Para entregar uma encomenda, toque em Entregar. Para retirar, toque em Retirar.',
    priority: 10,
  }),
  'courier-choice': Object.freeze({
    source: new URL('./assets/audio/courier-choice.m4a', import.meta.url).href,
    transcript: 'Use o teclado e escolha o destino correto.',
    priority: 20,
  }),
  'courier-confirm': Object.freeze({
    source: new URL('./assets/audio/courier-confirm.m4a', import.meta.url).href,
    transcript: 'Confira o destino. Se estiver correto, toque no botao azul.',
    priority: 20,
  }),
  'courier-dropoff': Object.freeze({
    source: new URL('./assets/audio/courier-dropoff.m4a', import.meta.url).href,
    transcript: 'Guarde a encomenda, feche o compartimento e confirme na tela.',
    priority: 30,
  }),
  'courier-close': Object.freeze({
    source: new URL('./assets/audio/courier-close.m4a', import.meta.url).href,
    transcript: 'Feche o compartimento anterior e aguarde a confirmacao antes de continuar.',
    priority: 40,
  }),
  'courier-success': Object.freeze({
    source: new URL('./assets/audio/courier-success.m4a', import.meta.url).href,
    transcript: 'Entrega registrada com sucesso.',
    priority: 50,
  }),
  'pickup-pin': Object.freeze({
    source: new URL('./assets/audio/pickup-pin.m4a', import.meta.url).href,
    transcript: 'Digite os seis numeros recebidos.',
    priority: 20,
  }),
  'pickup-qr': Object.freeze({
    source: new URL('./assets/audio/pickup-qr.m4a', import.meta.url).href,
    transcript: 'Aponte o codigo de retirada para a camera.',
    priority: 20,
  }),
  'pickup-open': Object.freeze({
    source: new URL('./assets/audio/pickup-open.m4a', import.meta.url).href,
    transcript: 'Retire a encomenda, feche o compartimento e confirme na tela.',
    priority: 30,
  }),
  'pickup-success': Object.freeze({
    source: new URL('./assets/audio/pickup-success.m4a', import.meta.url).href,
    transcript: 'Retirada concluida com sucesso.',
    priority: 50,
  }),
  cancel: Object.freeze({
    source: new URL('./assets/audio/cancel.m4a', import.meta.url).href,
    transcript: 'Para cancelar com seguranca, feche o compartimento e aguarde a confirmacao.',
    priority: 90,
  }),
  error: Object.freeze({
    source: new URL('./assets/audio/error.m4a', import.meta.url).href,
    transcript: 'Nao foi possivel continuar. Leia a mensagem na tela e tente novamente.',
    priority: 100,
  }),
});

export const AUDIO_PROMPT_IDS = Object.freeze(Object.keys(AUDIO_PROMPTS));

function clampVolume(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_PREFERENCES.volume;
  return Math.min(AUDIO_VOLUME_MAX, Math.max(AUDIO_VOLUME_MIN, parsed));
}

function readPreferences(storage) {
  if (!storage?.getItem) return { ...DEFAULT_PREFERENCES };

  try {
    const stored = JSON.parse(storage.getItem(AUDIO_PREFERENCE_STORAGE_KEY) || '{}');
    return {
      muted: typeof stored.muted === 'boolean' ? stored.muted : DEFAULT_PREFERENCES.muted,
      volume: clampVolume(stored.volume),
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

function createBrowserAudio(source) {
  return new Audio(source);
}

function getBrowserStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

export function createAudioGuidanceController({
  storage = getBrowserStorage(),
  createAudio = createBrowserAudio,
} = {}) {
  let preferences = readPreferences(storage);
  let currentPlayback = null;
  let lastPromptId = null;
  let lastTransitionKey = null;

  const persist = () => {
    if (!storage?.setItem) return;
    try {
      storage.setItem(AUDIO_PREFERENCE_STORAGE_KEY, JSON.stringify({
        muted: preferences.muted,
        volume: preferences.volume,
      }));
    } catch {
      // Audio remains usable when kiosk storage is unavailable or full.
    }
  };

  const stop = ({ clearTransition = false } = {}) => {
    if (currentPlayback) {
      currentPlayback.audio.pause?.();
      try {
        currentPlayback.audio.currentTime = 0;
      } catch {
        // Some embedded media implementations expose a read-only currentTime.
      }
      currentPlayback = null;
    }
    if (clearTransition) lastTransitionKey = null;
  };

  const play = (promptId, { transitionKey = promptId, force = false } = {}) => {
    const prompt = AUDIO_PROMPTS[promptId];
    if (!prompt) return false;
    if (!force && transitionKey === lastTransitionKey) return false;
    if (!force && currentPlayback && currentPlayback.priority > prompt.priority) return false;

    stop();
    lastPromptId = promptId;
    lastTransitionKey = transitionKey;
    if (preferences.muted) return false;

    const audio = createAudio(prompt.source);
    audio.preload = 'auto';
    audio.volume = preferences.volume;
    const playback = { audio, promptId, priority: prompt.priority };
    currentPlayback = playback;

    audio.addEventListener?.('ended', () => {
      if (currentPlayback === playback) currentPlayback = null;
    }, { once: true });

    try {
      Promise.resolve(audio.play?.()).catch(() => {
        if (currentPlayback === playback) currentPlayback = null;
      });
    } catch {
      currentPlayback = null;
      return false;
    }
    return true;
  };

  return Object.freeze({
    getPreferences() {
      return { ...preferences };
    },
    getCurrentPromptId() {
      return currentPlayback?.promptId || lastPromptId;
    },
    play,
    replay() {
      if (!lastPromptId || preferences.muted) return false;
      return play(lastPromptId, { transitionKey: lastTransitionKey, force: true });
    },
    setMuted(muted) {
      preferences = { ...preferences, muted: Boolean(muted) };
      if (preferences.muted) stop();
      persist();
      return { ...preferences };
    },
    setVolume(volume) {
      preferences = { ...preferences, volume: clampVolume(volume) };
      if (currentPlayback) currentPlayback.audio.volume = preferences.volume;
      persist();
      return { ...preferences };
    },
    stop,
    destroy() {
      stop({ clearTransition: true });
      lastPromptId = null;
    },
  });
}
