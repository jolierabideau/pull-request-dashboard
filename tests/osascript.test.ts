import { afterEach, describe, expect, it, vi } from 'vitest';

const execFile = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile }));

// `notify` decides on the platform at import time, so each case re-imports.
const onPlatform = async (platform: string) => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  vi.resetModules();
  return import('../src/notify/osascript.js');
};

const real = process.platform;
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: real, configurable: true });
  execFile.mockClear();
});

describe('notify', () => {
  it('shells out to osascript on macOS', async () => {
    const { notify } = await onPlatform('darwin');
    notify('Ready to merge', 'PR #2717', 'https://example.com/2717');
    expect(execFile).toHaveBeenCalledWith(
      'osascript', expect.any(Array), expect.any(Function),
    );
  });

  it('does nothing off macOS', async () => {
    const { notify } = await onPlatform('linux');
    notify('Ready to merge', 'PR #2717', 'https://example.com/2717');
    expect(execFile).not.toHaveBeenCalled();
  });

  it('reports whether the platform supports notifications', async () => {
    expect((await onPlatform('darwin')).notificationsSupported()).toBe(true);
    expect((await onPlatform('linux')).notificationsSupported()).toBe(false);
  });
});
