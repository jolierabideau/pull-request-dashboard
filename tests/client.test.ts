import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchOpenPrs, mapPullRequest } from '../src/github/client.js';
import type { Config } from '../src/types.js';
import { checkDot } from '../src/rules/checks.js';

const baseNode = {
  number: 1,
  title: 't',
  url: 'https://github.com/paranext/paranext-core/pull/1',
  isDraft: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  reviews: { nodes: [] },
  comments: { nodes: [] },
  reviewThreads: { nodes: [] },
  commits: { nodes: [] },
  headRefOid: 'abc123',
};

const nodeWithStatusContext = (state: string) => ({
  ...baseNode,
  statusCheckRollup: {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            contexts: {
              nodes: [{ context: 'ci/some-status', state }],
            },
          },
        },
      },
    ],
  },
});

describe('mapPullRequest — StatusContext mapping', () => {
  it('maps a PENDING StatusContext to IN_PROGRESS so checkDot reports pending', () => {
    const pr = mapPullRequest(nodeWithStatusContext('PENDING'));
    expect(pr.checks).toEqual([
      { name: 'ci/some-status', status: 'IN_PROGRESS', conclusion: null },
    ]);
    expect(checkDot(pr.checks)).toBe('pending');
  });

  it('maps an EXPECTED StatusContext to IN_PROGRESS so checkDot reports pending', () => {
    const pr = mapPullRequest(nodeWithStatusContext('EXPECTED'));
    expect(pr.checks).toEqual([
      { name: 'ci/some-status', status: 'IN_PROGRESS', conclusion: null },
    ]);
    expect(checkDot(pr.checks)).toBe('pending');
  });

  it('maps a FAILURE StatusContext to a completed FAILURE so checkDot reports fail', () => {
    const pr = mapPullRequest(nodeWithStatusContext('FAILURE'));
    expect(pr.checks).toEqual([
      { name: 'ci/some-status', status: 'COMPLETED', conclusion: 'FAILURE' },
    ]);
    expect(checkDot(pr.checks)).toBe('fail');
  });

  it('maps an ERROR StatusContext to a completed FAILURE so checkDot reports fail', () => {
    const pr = mapPullRequest(nodeWithStatusContext('ERROR'));
    expect(pr.checks).toEqual([
      { name: 'ci/some-status', status: 'COMPLETED', conclusion: 'FAILURE' },
    ]);
    expect(checkDot(pr.checks)).toBe('fail');
  });

  it('maps a SUCCESS StatusContext to a completed SUCCESS so checkDot reports pass', () => {
    const pr = mapPullRequest(nodeWithStatusContext('SUCCESS'));
    expect(pr.checks).toEqual([
      { name: 'ci/some-status', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ]);
    expect(checkDot(pr.checks)).toBe('pass');
  });

  it('leaves the CheckRun branch untouched', () => {
    const node = {
      ...baseNode,
      statusCheckRollup: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                contexts: {
                  nodes: [{ name: 'build', status: 'IN_PROGRESS', conclusion: null }],
                },
              },
            },
          },
        ],
      },
    };
    const pr = mapPullRequest(node);
    expect(pr.checks).toEqual([
      { name: 'build', status: 'IN_PROGRESS', conclusion: null },
    ]);
  });
});

describe('mapPullRequest — repo identity', () => {
  it('derives the repo from the PR url', () => {
    const pr = mapPullRequest({
      ...baseNode, url: 'https://github.com/paranext/paratext-10-studio/pull/202',
    });
    expect(pr.repo).toBe('paranext/paratext-10-studio');
  });

  it('throws when the url does not name a repo', () => {
    expect(() => mapPullRequest({ ...baseNode, url: 'u' })).toThrow(/which repo/);
  });
});

describe('fetchOpenPrs — search scope', () => {
  const cfg: Config = {
    repoPath: '/tmp', owner: 'paranext', name: 'paranext-core',
    me: 'jolierabideau', botLogins: [], pollIntervalMs: 180000, staleAfterHours: 48,
  };

  const searchedQuery = async (config: Config): Promise<string> => {
    const fetchMock = vi.fn(async (_url: string, _init: { body: string }) => new Response(
      JSON.stringify({ data: { search: { nodes: [] } } }), { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);
    await fetchOpenPrs(config);
    const init = fetchMock.mock.calls[0]?.[1];
    return (JSON.parse(init?.body ?? '{}') as { variables: { q: string } }).variables.q;
  };

  afterEach(() => { vi.unstubAllGlobals(); });

  it('searches the one repo by default', async () => {
    expect(await searchedQuery(cfg))
      .toBe('repo:paranext/paranext-core is:pr is:open author:jolierabideau');
  });

  it('searches the whole org when scope is org', async () => {
    expect(await searchedQuery({ ...cfg, scope: 'org' }))
      .toBe('org:paranext is:pr is:open author:jolierabideau');
  });
});
