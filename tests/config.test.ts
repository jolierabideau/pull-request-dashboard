import { describe, expect, it } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

const write = (obj: unknown): string => {
  const dir = mkdtempSync(join(tmpdir(), 'prd-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify(obj));
  return path;
};

const valid = {
  repoPath: '/tmp', owner: 'paranext', name: 'paranext-core',
  me: 'jolierabideau', botLogins: ['devin-ai-integration'],
  pollIntervalMs: 180000, staleAfterHours: 48,
};

describe('loadConfig', () => {
  it('loads a valid config', () => {
    expect(loadConfig(write(valid))).toEqual(valid);
  });

  it('names the missing field', () => {
    const { me, ...rest } = valid;
    expect(() => loadConfig(write(rest))).toThrow(/me/);
  });

  it('rejects a poll interval below 30s', () => {
    expect(() => loadConfig(write({ ...valid, pollIntervalMs: 1000 })))
      .toThrow(/pollIntervalMs/);
  });

  it('rejects a value still left as the example placeholder', () => {
    expect(() => loadConfig(write({ ...valid, me: '<your-github-login>' })))
      .toThrow(/me/);
  });

  it('rejects a repoPath that does not exist on disk', () => {
    expect(() => loadConfig(write({ ...valid, repoPath: '/nonexistent/clone' })))
      .toThrow(/repoPath/);
  });

  it('points at the example file when config.json is absent', () => {
    expect(() => loadConfig('/nonexistent/config.json'))
      .toThrow(/config\.example\.json/);
  });
});
