import { existsSync, readFileSync } from 'node:fs';
import type { Config } from './types.js';

const REQUIRED = [
  'repoPath', 'owner', 'name', 'me',
  'botLogins', 'pollIntervalMs', 'staleAfterHours',
] as const;

export function loadConfig(path: string): Config {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(
      `No config at ${path}. Copy config.example.json to config.json and edit it.`,
    );
  }

  const parsed = JSON.parse(raw) as Record<string, unknown>;
  for (const key of REQUIRED) {
    if (parsed[key] === undefined) throw new Error(`Config is missing "${key}".`);
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string' && /^<.+>$/.test(value)) {
      throw new Error(`Config "${key}" is still the example placeholder. Edit ${path}.`);
    }
  }
  if (!existsSync(parsed.repoPath as string)) {
    throw new Error(`Config "repoPath" does not exist: ${String(parsed.repoPath)}.`);
  }
  if ((parsed.pollIntervalMs as number) < 30_000) {
    throw new Error('Config "pollIntervalMs" must be at least 30000 (30s).');
  }
  return parsed as unknown as Config;
}
