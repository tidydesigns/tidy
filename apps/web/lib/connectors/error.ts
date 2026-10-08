/** Only deliberate, public connector messages should use this error. */
export class ConnectorError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
