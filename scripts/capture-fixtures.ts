// scripts/capture-fixtures.ts
// Usage: npx tsx scripts/capture-fixtures.ts 2717 2720 2664 ...
// Requires an authenticated `gh`. Writes tests/fixtures/pr-<n>.json.
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { PR_QUERY } from '../src/github/query.js';
import { mapPullRequest } from '../src/github/client.js';

const numbers = process.argv.slice(2).map(Number);
if (numbers.length === 0) throw new Error('Pass at least one PR number.');

mkdirSync('tests/fixtures', { recursive: true });

for (const number of numbers) {
  const raw = execFileSync(
    'gh',
    ['api', 'graphql', '-f', `query=${PR_QUERY}`,
     '-F', 'owner=paranext', '-F', 'name=paranext-core', '-F', `number=${number}`],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  const node = JSON.parse(raw).data.repository.pullRequest;
  writeFileSync(
    `tests/fixtures/pr-${number}.json`,
    `${JSON.stringify(mapPullRequest(node), null, 2)}\n`,
  );
  console.log(`captured pr-${number}`);
}
