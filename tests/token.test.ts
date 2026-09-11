import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('getToken', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock('node:child_process');
  });

  it('does not poison the cache on a throw; a later call retries', async () => {
    const execFileSync = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('gh not authenticated');
      })
      .mockImplementationOnce(() => 'good-token\n');

    vi.doMock('node:child_process', () => ({ execFileSync }));

    const { getToken } = await import('../src/github/token.js');

    expect(() => getToken()).toThrow(
      'Could not read a GitHub token. Run `gh auth login` and start again.',
    );
    expect(getToken()).toBe('good-token');
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });

  it('does not poison the cache on an empty token; a later call retries', async () => {
    const execFileSync = vi
      .fn()
      .mockImplementationOnce(() => '')
      .mockImplementationOnce(() => 'good-token\n');

    vi.doMock('node:child_process', () => ({ execFileSync }));

    const { getToken } = await import('../src/github/token.js');

    expect(() => getToken()).toThrow('`gh auth token` returned nothing.');
    expect(getToken()).toBe('good-token');
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });

  it('caches a good token so a second call does not shell out again', async () => {
    const execFileSync = vi.fn().mockImplementationOnce(() => 'good-token\n');

    vi.doMock('node:child_process', () => ({ execFileSync }));

    const { getToken } = await import('../src/github/token.js');

    expect(getToken()).toBe('good-token');
    expect(getToken()).toBe('good-token');
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it('clearTokenCache forces a re-read on the next call', async () => {
    const execFileSync = vi
      .fn()
      .mockImplementationOnce(() => 'first-token\n')
      .mockImplementationOnce(() => 'second-token\n');

    vi.doMock('node:child_process', () => ({ execFileSync }));

    const { getToken, clearTokenCache } = await import('../src/github/token.js');

    expect(getToken()).toBe('first-token');
    clearTokenCache();
    expect(getToken()).toBe('second-token');
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });
});
