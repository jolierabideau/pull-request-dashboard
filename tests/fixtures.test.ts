import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { PrInput } from '../src/types.js';

export const loadFixture = (n: number): PrInput =>
  JSON.parse(readFileSync(`tests/fixtures/pr-${n}.json`, 'utf8')) as PrInput;

const EXPECTED = [2717, 2720, 2664, 2742, 2795, 2796, 2687, 2635, 2180];

describe('fixtures', () => {
  it.each(EXPECTED)('pr-%i is present and well-formed', (n) => {
    const pr = loadFixture(n);
    expect(pr.number).toBe(n);
    expect(Array.isArray(pr.reviews)).toBe(true);
    expect(Array.isArray(pr.commits)).toBe(true);
    expect(typeof pr.isDraft).toBe('boolean');
  });

  it('pr-2180 carries the native inline threads it is here to pin', () => {
    expect(loadFixture(2180).threads.length).toBeGreaterThan(0);
  });

  it('pr-2664 head commit is a bare merge of main', () => {
    const head = loadFixture(2664).commits.at(-1);
    expect(head?.messageHeadline).toMatch(/Merge remote-tracking branch 'origin\/main'/);
    expect(head?.parentCount).toBe(2);
  });
});
