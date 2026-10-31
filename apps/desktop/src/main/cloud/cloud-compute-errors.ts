export class CloudComputeBusyError extends Error {
  constructor() {
    super("The design worker is busy. Retry shortly.");
    this.name = "CloudComputeBusyError";
  }
}
