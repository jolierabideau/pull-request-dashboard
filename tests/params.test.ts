import { describe, expect, it } from 'vitest';
import { isGithubName, parsePrNumber } from '../src/server/params.js';

describe('parsePrNumber', () => {
  it('accepts plain positive integers', () => {
    expect(parsePrNumber('1')).toBe(1);
    expect(parsePrNumber('2795')).toBe(2795);
  });

  it.each(['', '0', '-3', '1.5', '1e3', '0x10', ' 7', '7 ', '007', '+7', 'abc', '99999999999999999999'])(
    'rejects %j',
    (value) => { expect(parsePrNumber(value)).toBeNull(); },
  );
});

describe('isGithubName', () => {
  it('accepts owner and repo names', () => {
    expect(isGithubName('paranext')).toBe(true);
    expect(isGithubName('paratext-10-studio')).toBe(true);
    expect(isGithubName('a.b_c')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isGithubName('')).toBe(false);
    expect(isGithubName('a/b')).toBe(false);
    expect(isGithubName('a b')).toBe(false);
  });
});
