import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, LEGACY_DEFAULT_THRESHOLD, migrate, sanitize, SETTINGS_VERSION, SettingsStore } from '../src/app/settings';
import { MemoryStorage } from './helpers/memory-storage';

describe('SettingsStore', () => {
  it('persists the threshold and clamps bad values', () => {
    const storage = new MemoryStorage();
    const s = new SettingsStore(storage);
    expect(s.get().threshold).toBe(DEFAULT_SETTINGS.threshold);
    expect(DEFAULT_SETTINGS.threshold).toBe(0.6);
    s.update({ threshold: 0.4 });
    expect(new SettingsStore(storage).get().threshold).toBe(0.4);
    s.update({ threshold: 5 });
    expect(s.get().threshold).toBe(0.99);
    s.update({ manualLat: 200 });
    expect(s.get().manualLat).toBe(90);
  });

  it('notifies listeners', () => {
    const s = new SettingsStore(new MemoryStorage());
    let seen = 0;
    s.on('change', () => seen++);
    s.update({ autoSaveClips: true });
    expect(seen).toBe(1);
  });

  it('survives corrupt storage', () => {
    const storage = new MemoryStorage();
    storage.setItem('birdbrain.settings.v1', '{not json');
    expect(new SettingsStore(storage).get()).toEqual(DEFAULT_SETTINGS);
  });

  it('migrates a saved 25 % threshold (the old default) to 60 % exactly once', () => {
    const storage = new MemoryStorage();
    storage.setItem('birdbrain.settings.v1', JSON.stringify({ threshold: LEGACY_DEFAULT_THRESHOLD, overlapSeconds: 1 }));
    const s = new SettingsStore(storage);
    expect(s.get().threshold).toBe(0.6);
    expect(s.get().version).toBe(SETTINGS_VERSION);
    expect(s.get().overlapSeconds).toBe(1); // other values untouched
    // after the migration, 25 % is a choice and stays
    s.update({ threshold: 0.25 });
    expect(new SettingsStore(storage).get().threshold).toBe(0.25);
  });

  it('leaves a user-chosen threshold alone', () => {
    expect(migrate({ threshold: 0.3 }).threshold).toBe(0.3);
    expect(migrate({ threshold: 0.25, version: 2 }).threshold).toBe(0.25);
    expect(migrate({}).threshold).toBe(0.6);
    expect(migrate({ threshold: 0.25, version: 1 }).threshold).toBe(0.6);
  });

  it('never lets the auto-save threshold fall below the detection threshold', () => {
    expect(DEFAULT_SETTINGS.autoSaveMinConfidence).toBe(0.6);
    expect(sanitize({ ...DEFAULT_SETTINGS, threshold: 0.7, autoSaveMinConfidence: 0.5 }).autoSaveMinConfidence).toBe(0.7);
    expect(sanitize({ ...DEFAULT_SETTINGS, threshold: 0.3, autoSaveMinConfidence: 0.5 }).autoSaveMinConfidence).toBe(0.5);
    const s = new SettingsStore(new MemoryStorage());
    s.update({ autoSaveMinConfidence: 0.2 });
    expect(s.get().autoSaveMinConfidence).toBe(0.6);
    s.update({ threshold: 0.8 });
    expect(s.get().autoSaveMinConfidence).toBe(0.8);
    // an old store with 50 % auto-save and the migrated threshold ends at 60 %
    const storage = new MemoryStorage();
    storage.setItem('birdbrain.settings.v1', JSON.stringify({ threshold: 0.25, autoSaveMinConfidence: 0.5 }));
    expect(new SettingsStore(storage).get().autoSaveMinConfidence).toBe(0.6);
  });
});


describe('auto-save detection windows (settings version 3)', () => {
  it('is on by default for new devices', () => {
    expect(new SettingsStore(null).get().autoSaveClips).toBe(true);
  });
  it('is switched on once for settings saved before version 3, and a later "off" is kept', () => {
    expect(migrate({ version: 2, autoSaveClips: false }).autoSaveClips).toBe(true);
    expect(migrate({ autoSaveClips: false }).autoSaveClips).toBe(true);
    expect(migrate({ version: 3, autoSaveClips: false }).autoSaveClips).toBe(false);
  });
});
