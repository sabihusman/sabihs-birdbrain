import { describe, expect, it } from 'vitest';
import { backendLabel, deviceLabel, groupCounts, layoutLabel, micLabel, screenLabel, shortDuration, timeZoneLabel, updatedText } from '../src/ui/usage-labels';
import { PAGES } from '../src/app/usage-counts';

describe('Admin › Usage labels', () => {
  it('groups every route the app sends under a tab-like name', () => {
    for (const p of PAGES) expect(screenLabel(p), p).not.toBe('Other');
    expect(screenLabel('species-detail')).toBe('Species');
    expect(screenLabel('recording')).toBe('Recordings');
    expect(screenLabel('nope')).toBe('Other');
  });

  it('names devices as in the mockup', () => {
    expect(deviceLabel('iOS|Safari|Mobile')).toBe('iPhone Safari');
    expect(deviceLabel('iOS|Chrome|Mobile')).toBe('iPhone Chrome');
    expect(deviceLabel('iOS|Safari|Tablet')).toBe('iPad Safari');
    expect(deviceLabel('Android|Chrome|Mobile')).toBe('Android Chrome');
    expect(deviceLabel('Windows|Edge|Desktop')).toBe('Desktop');
    expect(deviceLabel('macOS|Firefox|Desktop')).toBe('Desktop');
    expect(deviceLabel('||')).toBe('Other');
  });

  it('turns time zones into regions, US and Canada apart', () => {
    expect(timeZoneLabel('America/Chicago')).toBe('US Central');
    expect(timeZoneLabel('America/Indiana/Indianapolis')).toBe('US Eastern');
    expect(timeZoneLabel('America/Indiana/Knox')).toBe('US Central');
    expect(timeZoneLabel('America/New_York')).toBe('US Eastern');
    expect(timeZoneLabel('America/Phoenix')).toBe('US Mountain');
    expect(timeZoneLabel('America/Los_Angeles')).toBe('US Pacific');
    expect(timeZoneLabel('America/Toronto')).toBe('Canada Eastern');
    expect(timeZoneLabel('America/Winnipeg')).toBe('Canada Central');
    expect(timeZoneLabel('America/Vancouver')).toBe('Canada Pacific');
    expect(timeZoneLabel('America/Halifax')).toBe('Canada Atlantic');
    expect(timeZoneLabel('Europe/Zurich')).toBe('Other');
    expect(timeZoneLabel('')).toBe('Other');
  });

  it('adds up rows with the same label and folds the tail into Other', () => {
    const rows = [
      { value: 'America/Chicago', count: 50 },
      { value: 'America/Menominee', count: 5 },
      { value: 'America/New_York', count: 40 },
      { value: 'Europe/Zurich', count: 3 },
    ];
    expect(groupCounts(rows, timeZoneLabel)).toEqual([
      { label: 'US Central', count: 55 },
      { label: 'US Eastern', count: 40 },
      { label: 'Other', count: 3 },
    ]);
    const many = ['a', 'b', 'c', 'd'].map((v, i) => ({ value: v, count: 10 - i }));
    expect(groupCounts(many, (v) => v.toUpperCase(), 3)).toEqual([
      { label: 'A', count: 10 },
      { label: 'B', count: 9 },
      { label: 'Other', count: 15 },
    ]);
    expect(groupCounts([], screenLabel)).toEqual([]);
  });

  it('plain words for layouts, backends, microphone problems and times', () => {
    expect(layoutLabel('birdamp')).toBe('BirdAmp');
    expect(backendLabel('webgl')).toBe('WebGL (fast)');
    expect(micLabel('denied')).toBe('Microphone blocked');
    expect(shortDuration(250)).toBe('4m 10s');
    expect(shortDuration(42.4)).toBe('42s');
    expect(shortDuration(3700)).toBe('1h 1m');
    expect(shortDuration(null)).toBe('–');
    const now = new Date('2026-11-10T18:12:00Z');
    expect(updatedText('2026-11-10T18:00:00Z', now, false)).toBe('Updated 12 min ago (every 15 min).');
    expect(updatedText('2026-11-10T18:11:50Z', now, false)).toBe('Updated just now (every 15 min).');
    expect(updatedText('2026-11-10T16:00:00Z', now, true)).toBe('PostHog didn’t answer; showing the numbers from 2 h ago.');
  });
});
