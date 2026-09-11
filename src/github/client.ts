import type { CheckContext, Config, PrInput } from '../types.js';
import { clearTokenCache, getToken } from './token.js';
import { LIST_QUERY } from './query.js';

interface GqlNode { [key: string]: any }

export function mapPullRequest(node: GqlNode): PrInput {
  return {
    number: node.number,
    title: node.title,
    url: node.url,
    isDraft: node.isDraft,
    headOid: node.headRefOid,
    mergeable: node.mergeable,
    mergeStateStatus: node.mergeStateStatus,
    reviews: (node.reviews?.nodes ?? []).map((r: GqlNode) => ({
      id: r.id,
      author: r.author?.login ?? 'unknown',
      state: r.state,
      submittedAt: r.submittedAt,
      bodyText: r.bodyText ?? '',
      lastEditedAt: r.lastEditedAt ?? null,
    })),
    comments: (node.comments?.nodes ?? []).map((c: GqlNode) => ({
      author: c.author?.login ?? 'unknown',
      createdAt: c.createdAt,
    })),
    commits: (node.commits?.nodes ?? []).map(({ commit }: GqlNode) => ({
      oid: commit.oid,
      committedDate: commit.committedDate,
      authorLogin: commit.author?.user?.login ?? null,
      authorEmail: commit.author?.email ?? null,
      messageHeadline: commit.messageHeadline,
      parentCount: commit.parents?.totalCount ?? 1,
    })),
    threads: (node.reviewThreads?.nodes ?? [])
      .map((t: GqlNode) => {
        const last = t.comments?.nodes?.[0];
        return last
          ? {
              isResolved: t.isResolved,
              lastCommentAuthor: last.author?.login ?? 'unknown',
              lastCommentAt: last.createdAt,
            }
          : null;
      })
      .filter((t: unknown): t is NonNullable<typeof t> => t !== null),
    checks: mapChecks(node),
  };
}

function mapChecks(node: GqlNode): CheckContext[] {
  const contexts =
    node.statusCheckRollup?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  return contexts.map((c: GqlNode) =>
    c.name !== undefined
      ? { name: c.name, status: c.status, conclusion: c.conclusion ?? null }
      : mapStatusContext(c),
  );
}

function mapStatusContext(c: GqlNode): CheckContext {
  const name = c.context;
  switch (c.state) {
    case 'PENDING':
    case 'EXPECTED':
      return { name, status: 'IN_PROGRESS', conclusion: null };
    case 'FAILURE':
    case 'ERROR':
      return { name, status: 'COMPLETED', conclusion: 'FAILURE' };
    case 'SUCCESS':
      return { name, status: 'COMPLETED', conclusion: 'SUCCESS' };
    default:
      return { name, status: 'COMPLETED', conclusion: null };
  }
}

export async function fetchOpenPrs(cfg: Config): Promise<PrInput[]> {
  const q = `repo:${cfg.owner}/${cfg.name} is:pr is:open author:${cfg.me}`;
  const data = await graphql<{ search: { nodes: GqlNode[] } }>(LIST_QUERY, { q });
  return data.search.nodes.filter((n) => n.number !== undefined).map(mapPullRequest);
}

async function graphql<T>(
  query: string,
  variables: Record<string, unknown>,
  retried = false,
): Promise<T> {
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      authorization: `bearer ${getToken()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (response.status === 401 && !retried) {
    clearTokenCache();
    return graphql<T>(query, variables, true);
  }
  if (!response.ok) {
    throw new Error(`GitHub returned ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join('; '));
  if (!body.data) throw new Error('GitHub returned no data.');
  return body.data;
}
