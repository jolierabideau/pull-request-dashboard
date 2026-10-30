const GITHUB_NAME = /^[A-Za-z0-9_.-]+$/;
const PR_NUMBER = /^[1-9]\d*$/;

export const isGithubName = (value: string): boolean => GITHUB_NAME.test(value);

/** The PR number from a route parameter, or null unless it is a plain positive integer. */
export const parsePrNumber = (value: string): number | null => {
  if (!PR_NUMBER.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
};
