import { describe, expect, it } from 'vitest';
import { answerQuestion, canAsk, checkCaps } from '../src/ask.js';
import { createUsageStore, openDatabase } from '../src/db.js';
import { LABELS } from './helpers.js';

describe('approval gating', () => {
  it('only approved users can ask', () => {
    expect(canAsk({ status: 'approved' })).toBe(true);
    expect(canAsk({ status: 'pending' })).toBe(false);
    expect(canAsk({ status: 'rejected' })).toBe(false);
    expect(canAsk({ status: 'disabled' })).toBe(false);
    expect(canAsk(null)).toBe(false);
  });
});

describe('daily caps', () => {
  it('enforces per-user and global caps per UTC day', () => {
    const usage = createUsageStore(openDatabase(':memory:'));
    const caps = { perUserDaily: 2, globalDaily: 3 };
    const day1 = new Date('2026-05-01T10:00:00Z');
    expect(checkCaps(usage, 'u1', caps, day1)).toEqual({ ok: true });
    usage.record('u1', day1);
    usage.record('u1', day1);
    expect(checkCaps(usage, 'u1', caps, day1)).toEqual({ ok: false, reason: 'user_cap' });
    expect(checkCaps(usage, 'u2', caps, day1)).toEqual({ ok: true });
    usage.record('u2', day1);
    expect(checkCaps(usage, 'u3', caps, day1)).toEqual({ ok: false, reason: 'global_cap' });
    // next day resets
    const day2 = new Date('2026-05-02T00:00:01Z');
    expect(checkCaps(usage, 'u1', caps, day2)).toEqual({ ok: true });
  });
});

describe('answerQuestion pipeline', () => {
  const deps = () => ({
    labels: LABELS,
    wiki: async (sci: string) => ({ title: sci, extract: 'It eats seeds.', url: 'https://en.wikipedia.org/wiki/x' }),
    model: async () => '<p>It eats seeds.</p>',
    usage: createUsageStore(openDatabase(':memory:')),
    caps: { perUserDaily: 5, globalDaily: 5 },
    maxQuestionChars: 500,
  });
  it('rejects pending users before touching the network', async () => {
    let wikiCalls = 0;
    const d = deps();
    d.wiki = async () => {
      wikiCalls++;
      return null;
    };
    const out = await answerQuestion(d, { id: 'u', status: 'pending' }, { species: 'Turdus merula', question: 'What?' });
    expect(out.status).toBe(403);
    expect(wikiCalls).toBe(0);
  });
  it('rejects unknown species and bad bodies', async () => {
    const d = deps();
    expect((await answerQuestion(d, { id: 'u', status: 'approved' }, { species: 'Dog', question: 'What?' })).status).toBe(400);
    expect((await answerQuestion(d, { id: 'u', status: 'approved' }, { species: 'Turdus merula', question: 'What?', x: 1 })).status).toBe(400);
  });
  it('returns plain text and the source, and counts usage', async () => {
    const d = deps();
    const out = await answerQuestion(d, { id: 'u', status: 'approved' }, { species: 'Turdus merula', question: 'What does it eat?' });
    expect(out.status).toBe(200);
    if (out.status === 200) {
      expect(out.body.answer).toBe('It eats seeds.');
      expect(out.body.source.url).toContain('wikipedia');
    }
    expect(d.usage.get('user:u')).toBe(1);
    expect(d.usage.get('global')).toBe(1);
  });
  it('does not count usage when Wikipedia has nothing', async () => {
    const d = deps();
    d.wiki = async () => null;
    const out = await answerQuestion(d, { id: 'u', status: 'approved' }, { species: 'Turdus merula', question: 'What?' });
    expect(out.status).toBe(404);
    expect(d.usage.get('global')).toBe(0);
  });
});
