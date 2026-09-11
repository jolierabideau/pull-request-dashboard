import { describe, expect, it } from 'vitest';
import { mapPullRequest } from '../src/github/client.js';
import { checkDot } from '../src/rules/checks.js';

const baseNode = {
  number: 1,
  title: 't',
  url: 'u',
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
