import { describe, expect, it } from 'vitest';
import { parseFooter } from '../src/rules/footer.js';

describe('parseFooter', () => {
  it('parses the complete! form', () => {
    expect(parseFooter(
      'Reviewable status:  complete! all files reviewed, all discussions resolved.',
    )).toEqual({
      files: 'all', discussions: 'resolved', waitingOn: [], complete: true,
    });
  });

  it('parses one unresolved discussion waiting on one person', () => {
    expect(parseFooter(
      'Reviewable status: all files reviewed, 1 unresolved discussion (waiting on jolierabideau).',
    )).toEqual({
      files: 'all',
      discussions: { unresolved: 1 },
      waitingOn: ['jolierabideau'],
      complete: false,
    });
  });

  it('parses partial file counts', () => {
    expect(parseFooter(
      'Reviewable status: 8 of 28 files reviewed, all discussions resolved.',
    )).toEqual({
      files: { reviewed: 8, total: 28 },
      discussions: 'resolved',
      waitingOn: [],
      complete: false,
    });
  });

  it('parses two names in the waiting-on clause', () => {
    expect(parseFooter(
      'Reviewable status: 18 of 28 files reviewed, 2 unresolved discussions (waiting on jolierabideau and katherinejensen00).',
    )).toEqual({
      files: { reviewed: 18, total: 28 },
      discussions: { unresolved: 2 },
      waitingOn: ['jolierabideau', 'katherinejensen00'],
      complete: false,
    });
  });

  // The case the spec originally got wrong: resolution and court are
  // independent. PR #2338.
  it('parses resolved discussions that still have someone waiting', () => {
    expect(parseFooter(
      'Reviewable status: 0 of 1 files reviewed, all discussions resolved (waiting on irahopkinson).',
    )).toEqual({
      files: { reviewed: 0, total: 1 },
      discussions: 'resolved',
      waitingOn: ['irahopkinson'],
      complete: false,
    });
  });

  it('finds a footer that is not at the end of the body', () => {
    const body = [
      'Some review prose.',
      'Reviewable status: all files reviewed, 1 unresolved discussion (waiting on katherinejensen00).',
      'src/renderer/thing.tsx line 181 at r1 (raw file):',
      'a trailing per-file comment block',
    ].join('\n');
    expect(parseFooter(body)?.waitingOn).toEqual(['katherinejensen00']);
  });

  it('uses the last footer when a body somehow contains two', () => {
    const body = [
      'Reviewable status: all files reviewed, 5 unresolved discussions (waiting on alice).',
      'Reviewable status:  complete! all files reviewed, all discussions resolved.',
    ].join('\n');
    expect(parseFooter(body)?.complete).toBe(true);
  });

  it('returns null when there is no footer', () => {
    expect(parseFooter('Thanks for making those changes, Jolie!')).toBeNull();
  });

  it('returns null for an unrecognizable status line rather than guessing', () => {
    expect(parseFooter('Reviewable status: something entirely new.')).toBeNull();
  });
});
