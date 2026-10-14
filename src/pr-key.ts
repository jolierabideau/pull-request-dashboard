/** A PR is identified by its repo plus its number: two repos can both have a #205. */
export const prKey = (repo: string, number: number): string => `${repo}#${number}`;

const PR_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/;

/** The `owner/name` a pull request URL belongs to. */
export function repoFromUrl(url: string): string {
  const match = PR_URL.exec(url);
  if (match === null) {
    throw new Error(`Cannot tell which repo a pull request belongs to from its URL: ${url}`);
  }
  return match[1]!;
}
