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

  it('leaves scope unset when the config omits it', () => {
    expect(loadConfig(write(valid)).scope).toBeUndefined();
  });

  it.each(['repo', 'org'])('accepts scope "%s"', (scope) => {
    expect(loadConfig(write({ ...valid, scope })).scope).toBe(scope);
  });

  it('rejects an unknown scope, naming the field', () => {
    expect(() => loadConfig(write({ ...valid, scope: 'everything' })))
      .toThrow(/scope/);
  });

  it('leaves quietAfterDays unset when omitted', () => {
    expect(loadConfig(write(valid)).quietAfterDays).toBeUndefined();
  });

  it('accepts a positive quietAfterDays', () => {
    expect(loadConfig(write({ ...valid, quietAfterDays: 14 })).quietAfterDays).toBe(14);
  });

  it.each([0, -3, '30', null])('rejects quietAfterDays %j, naming the field', (quietAfterDays) => {
    expect(() => loadConfig(write({ ...valid, quietAfterDays }))).toThrow(/quietAfterDays/);
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
