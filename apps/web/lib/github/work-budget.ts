import { AsyncLocalStorage } from "node:async_hooks";

export class GitHubWorkLimitError extends Error {
  constructor() {
    super("Too many GitHub results. Narrow the repository selection or pull request.");
  }
}

type WorkBudget = { requests: number; bytes: number; signal: AbortSignal };
const workBudgets = new AsyncLocalStorage<WorkBudget>();

/** Nested services and parallel lookups share one allowance; separate calls remain isolated. */
export function boundedGitHubOperation<Args extends unknown[], Result>(
  operation: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  return (...args) => {
    if (workBudgets.getStore()) return operation(...args);
    return workBudgets.run(
      { requests: 40, bytes: 24 * 1024 * 1024, signal: AbortSignal.timeout(30000) },
      () => operation(...args),
    );
  };
}

/** Charge before remote I/O, including requests that subsequently fail. */
export function reserveGitHubRequest() {
  const budget = workBudgets.getStore();
  if (budget && (--budget.requests < 0 || budget.bytes <= 0)) throw new GitHubWorkLimitError();
  budget?.signal.throwIfAborted();
  return budget?.signal;
}

/** Charge actual stream chunks before retaining or parsing them. */
export function consumeGitHubResponseBytes(bytes: number) {
  const budget = workBudgets.getStore();
  if (budget && (budget.bytes -= bytes) < 0) throw new GitHubWorkLimitError();
}
