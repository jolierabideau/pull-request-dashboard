import { execFileSync } from 'node:child_process';

let cached: string | null = null;

export function getToken(): string {
  if (cached !== null) return cached;
  try {
    cached = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error(
      'Could not read a GitHub token. Run `gh auth login` and start again.',
    );
  }
  if (cached === '') throw new Error('`gh auth token` returned nothing.');
  return cached;
}

/** Called on a 401 — tokens rotate under a long-running dev server. */
export function clearTokenCache(): void {
  cached = null;
}
