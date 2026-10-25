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
    expect(PERSIST_REASON).toContain('so they are not deleted when space runs low');
    expect(PERSIST_EXPLAINED).toContain('the browser may delete them on its own when the phone runs low on space');
    expect(PERSIST_EXPLAINED).toContain('Firefox shows a prompt');
    expect(PERSIST_EXPLAINED).toContain('Nothing leaves your phone either way.');
  });
});
