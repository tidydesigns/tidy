/** Only checked, user-facing messages belong in this type. Infrastructure errors
 * remain ordinary errors and must never be serialized by the HTTP boundary. */
export class GitHubRequestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
