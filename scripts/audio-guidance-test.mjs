import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUDIO_PREFERENCE_STORAGE_KEY,
  AUDIO_PROMPT_IDS,
  AUDIO_PROMPTS,
  AUDIO_VOLUME_MAX,
  AUDIO_VOLUME_MIN,
  createAudioGuidanceController,
} from '../web/src/audioGuidance.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const audioDirectory = join(root, 'web', 'src', 'assets', 'audio');
const manifest = JSON.parse(readFileSync(join(audioDirectory, 'manifest.json'), 'utf8'));

assert.deepEqual(
  [...AUDIO_PROMPT_IDS].sort(),
  manifest.prompts.map((prompt) => prompt.id).sort(),
  'manifest and controller must expose the same closed prompt list'
);

const sensitiveSpeech = /\b(?:apartamento|bloco|nome|pin|porta|qr|unidade)\b|\d|[@{}]/i;
for (const entry of manifest.prompts) {
  const prompt = AUDIO_PROMPTS[entry.id];
  assert.equal(prompt.transcript, entry.transcript, `${entry.id} transcript differs from the manifest`);
  assert.doesNotMatch(entry.transcript, sensitiveSpeech, `${entry.id} can disclose a sensitive value`);

  const filePath = join(audioDirectory, entry.file);
  const bytes = readFileSync(filePath);
  assert.equal(statSync(filePath).size, entry.bytes, `${entry.file} byte count differs`);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `${entry.file} hash differs`);
}

const stored = new Map();
const storage = {
  getItem(key) {
    return stored.get(key) ?? null;
  },
  setItem(key, value) {
    stored.set(key, value);
  },
};
const audioInstances = [];

function createFakeAudio(source) {
  const listeners = new Map();
  const audio = {
    source,
    currentTime: 12,
    paused: false,
    playCount: 0,
    volume: 1,
    addEventListener(event, listener) {
      listeners.set(event, listener);
    },
    pause() {
      this.paused = true;
    },
    play() {
      this.playCount += 1;
      return Promise.resolve();
    },
    finish() {
      listeners.get('ended')?.();
    },
  };
  audioInstances.push(audio);
  return audio;
}

const controller = createAudioGuidanceController({ storage, createAudio: createFakeAudio });
assert.deepEqual(controller.getPreferences(), { muted: true, volume: 0.45 });
assert.equal(controller.play('home'), false, 'muted mode must not instantiate media');
assert.equal(audioInstances.length, 0);

controller.setMuted(false);
assert.equal(controller.replay(), true, 'enabling audio can replay the current stage from a user gesture');
assert.equal(audioInstances.length, 1);
assert.equal(audioInstances[0].playCount, 1);
assert.equal(audioInstances[0].volume, 0.45);

assert.equal(controller.play('home'), false, 'the same transition must not play twice');
assert.equal(audioInstances.length, 1);
assert.equal(controller.play('courier-choice'), true);
assert.equal(audioInstances[0].paused, true, 'a stage change must interrupt the prior prompt');
assert.equal(audioInstances[0].currentTime, 0);

controller.setVolume(4);
assert.equal(controller.getPreferences().volume, AUDIO_VOLUME_MAX);
assert.equal(audioInstances.at(-1).volume, AUDIO_VOLUME_MAX);
controller.setVolume(-2);
assert.equal(controller.getPreferences().volume, AUDIO_VOLUME_MIN);

assert.equal(controller.play('error'), true);
assert.equal(controller.play('home'), false, 'a lower priority prompt cannot interrupt an active error');
assert.equal(controller.play('unapproved-dynamic-prompt'), false, 'unknown prompts must be rejected');

controller.setMuted(true);
assert.equal(audioInstances.at(-1).paused, true, 'muting must stop current playback');
assert.deepEqual(
  Object.keys(JSON.parse(stored.get(AUDIO_PREFERENCE_STORAGE_KEY))).sort(),
  ['muted', 'volume'],
  'only non-identifying audio preferences may be persisted'
);
controller.destroy();

console.log(`Audio guidance valid: ${manifest.prompts.length} fixed prompts, integrity and privacy policy verified.`);
