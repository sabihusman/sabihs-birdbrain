import { describe, expect, it } from 'vitest';
import { keyedPool, syncChildren } from '../src/ui/keyed';

/** Just enough of a DOM element for the helpers (the unit tests run without a DOM). */
class FakeNode {
  parent: FakeNode | null = null;
  childNodes: FakeNode[] = [];
  constructor(readonly name: string) {}
  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  insertBefore(node: FakeNode, ref: FakeNode | null) {
    node.remove();
    const i = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
    this.childNodes.splice(i, 0, node);
    node.parent = this;
    inserts++;
    return node;
  }
  remove() {
    if (!this.parent) return;
    this.parent.childNodes.splice(this.parent.childNodes.indexOf(this), 1);
    this.parent = null;
  }
}
let inserts = 0;
const names = (p: FakeNode) => p.childNodes.map((n) => n.name);

describe('keeping Listen cards between renders', () => {
  it('moves only what is out of place and drops the rest', () => {
    const list = new FakeNode('list');
    const [a, b, c] = ['a', 'b', 'c'].map((n) => new FakeNode(n));
    syncChildren(list as never, [a, b, c] as never);
    expect(names(list)).toEqual(['a', 'b', 'c']);
    inserts = 0;
    syncChildren(list as never, [a, b, c] as never);
    expect(inserts, 'same order: nothing touched').toBe(0);
    syncChildren(list as never, [c, a] as never);
    expect(names(list)).toEqual(['c', 'a']);
    expect(inserts, 'the newest bird moves to the top in one move').toBe(1);
    expect(b.parent).toBeNull();
  });

  it('hands back the same card for the same key, and disposes cards no longer shown', () => {
    const pool = keyedPool<{ el: HTMLElement; dispose: () => void }>();
    const disposed: string[] = [];
    let built = 0;
    const make = (k: string) => () => {
      built++;
      const node = new FakeNode(k);
      return { el: node as unknown as HTMLElement, dispose: () => disposed.push(k) };
    };
    const first = pool.take('Acanthis flammea', make('redpoll'));
    pool.take('Turdus merula', make('blackbird'));
    pool.sweep();
    expect(pool.take('Acanthis flammea', make('redpoll'))).toBe(first);
    pool.sweep();
    expect(built).toBe(2);
    expect(disposed).toEqual(['blackbird']);
    expect(pool.size).toBe(1);
    pool.clear();
    expect(disposed).toEqual(['blackbird', 'redpoll']);
  });
});
