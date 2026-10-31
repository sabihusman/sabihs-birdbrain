import { describe, expect, it } from 'vitest';
import { askToKeepStorageOnce, PERSIST_ASKED_KEY, PERSIST_EXPLAINED, PERSIST_REASON } from '../src/storage/quota';
import { MemoryStorage } from './helpers/memory-storage';

function manager(opts: { persisted?: boolean; grant?: boolean; missing?: boolean }) {
  const calls: string[] = [];
  return {
    calls,
    m: opts.missing
      ? undefined
      : {
          persisted: async () => {
            calls.push('persisted');
            return opts.persisted ?? false;
          },
          persist: async () => {
            calls.push('persist');
            return opts.grant ?? false;
          },
        },
  };
}

describe('asking the browser to keep storage (DECISIONS.md #84)', () => {
  it('asks once, says why first, and never asks again after a refusal', async () => {
    const s = new MemoryStorage();
    const said: string[] = [];
    const a = manager({ grant: false });
    expect(await askToKeepStorageOnce(s, a.m, () => said.push(PERSIST_REASON))).toBe('denied');
    expect(a.calls).toEqual(['persisted', 'persist']);
    expect(said).toHaveLength(1);
    expect(s.getItem(PERSIST_ASKED_KEY)).not.toBeNull();
    const b = manager({ grant: true });
    expect(await askToKeepStorageOnce(s, b.m)).toBe('asked-before');
    expect(b.calls).toEqual([]);
  });

  it('records storage that is already kept without asking, and copes with no support', async () => {
    const said: string[] = [];
    const a = manager({ persisted: true });
    expect(await askToKeepStorageOnce(new MemoryStorage(), a.m, () => said.push('x'))).toBe('already');
    expect(a.calls).toEqual(['persisted']);
    expect(said).toEqual([]);
    expect(await askToKeepStorageOnce(new MemoryStorage(), manager({ grant: true }).m)).toBe('granted');
    expect(await askToKeepStorageOnce(new MemoryStorage(), manager({ missing: true }).m)).toBe('unsupported');
  });

  it('explains the reasons and the benefit in plain words', () => {
    expect(PERSIST_REASON).toBe('Asking your browser to keep the model and sightings, so low space can’t delete them.');
    expect(PERSIST_EXPLAINED).toContain('the browser may delete them when space is low');
    expect(PERSIST_EXPLAINED).toContain('Safari clears sites left unused; anything not exported is lost');
    expect(PERSIST_EXPLAINED).toContain('Firefox asks');
    expect(PERSIST_EXPLAINED).toContain('Nothing leaves your phone.');
  });
});

describe('what the browser decided is said too (UI/UX audit finding 11)', () => {
  it('says kept or not kept, in the same words as Settings, and nothing when nothing was asked', async () => {
    const { persistOutcomeText } = await import('../src/storage/quota');
    expect(persistOutcomeText('granted')).toMatch(/^Storage is kept/);
    expect(persistOutcomeText('denied')).toMatch(/may delete the model and sightings if space runs low\. Settings › Storage can ask again\.$/);
    for (const o of ['already', 'asked-before', 'unsupported'] as const) expect(persistOutcomeText(o)).toBeNull();
  });
});
