import { describe, expect, it, vi } from 'vitest';
import { buildPrompt, parseVerdict, resolveEscalation } from '../src/claude/escalate.js';
import { openStore } from '../src/store/db.js';
import type { ClaudeVerdict, ReviewInput } from '../src/types.js';

const review: ReviewInput = {
  id: 'R_1', author: 'katherinejensen00', state: 'COMMENTED',
  submittedAt: '2026-09-08T22:06:03Z',
  bodyText: 'Verdict: 2 blocking, 3 warnings. Fix the readDirection default.',
  lastEditedAt: null,
};

const verdict: ClaudeVerdict = {
  court: 'me', blockingCount: 2,
  asks: ['fix the readDirection default'], confidence: 'high',
};

describe('buildPrompt', () => {
  it('includes the review body and the reason', () => {
    const prompt = buildPrompt(review, 'commented-no-footer');
    expect(prompt).toContain('readDirection');
    expect(prompt).toContain('commented-no-footer');
  });
});

describe('parseVerdict', () => {
  it('accepts a well-formed verdict', () => {
    expect(parseVerdict(verdict)).toEqual(verdict);
  });

  it('rejects an unknown court value', () => {
    expect(() => parseVerdict({ ...verdict, court: 'nobody' })).toThrow(/court/);
  });

  it('rejects a non-array asks', () => {
    expect(() => parseVerdict({ ...verdict, asks: 'fix it' })).toThrow(/asks/);
  });

  it('rejects a non-numeric blockingCount', () => {
    expect(() => parseVerdict({ ...verdict, blockingCount: 'two' })).toThrow(/blockingCount/);
  });

  it('rejects an object blockingCount', () => {
    expect(() => parseVerdict({ ...verdict, blockingCount: {} })).toThrow(/blockingCount/);
  });

  it('rejects a negative blockingCount', () => {
    expect(() => parseVerdict({ ...verdict, blockingCount: -1 })).toThrow(/blockingCount/);
  });

  it('defaults a missing blockingCount to 0', () => {
    const { blockingCount, ...rest } = verdict;
    expect(parseVerdict(rest).blockingCount).toBe(0);
  });
});

describe('resolveEscalation', () => {
  it('calls the model on a miss and caches the result', async () => {
    const store = openStore(':memory:');
    const ask = vi.fn().mockResolvedValue(verdict);

    expect(await resolveEscalation(review, 'commented-no-footer', store, ask))
      .toEqual(verdict);
    expect(await resolveEscalation(review, 'commented-no-footer', store, ask))
      .toEqual(verdict);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('re-asks when the review has been edited since caching', async () => {
    const store = openStore(':memory:');
    const ask = vi.fn().mockResolvedValue(verdict);

    await resolveEscalation(review, 'commented-no-footer', store, ask);
    await resolveEscalation(
      { ...review, lastEditedAt: '2026-09-09T00:00:00Z' },
      'commented-no-footer', store, ask,
    );
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('returns null rather than throwing when the model call fails', async () => {
    const store = openStore(':memory:');
    const ask = vi.fn().mockRejectedValue(new Error('no credentials'));

    expect(await resolveEscalation(review, 'commented-no-footer', store, ask))
      .toBeNull();
  });

  it('returns null and does not cache when the model returns a malformed payload', async () => {
    const store = openStore(':memory:');
    const badAsk = vi.fn().mockResolvedValue({ court: 'nobody' });

    expect(await resolveEscalation(review, 'commented-no-footer', store, badAsk))
      .toBeNull();

    const goodAsk = vi.fn().mockResolvedValue(verdict);
    expect(await resolveEscalation(review, 'commented-no-footer', store, goodAsk))
      .toEqual(verdict);
    expect(goodAsk).toHaveBeenCalledTimes(1);
  });
});
