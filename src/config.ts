import { readFileSync } from 'node:fs';
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
  if ((parsed.pollIntervalMs as number) < 30_000) {
    throw new Error('Config "pollIntervalMs" must be at least 30000 (30s).');
  }
  return parsed as unknown as Config;
}
