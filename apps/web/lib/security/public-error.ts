/** Deliberate application messages that may be returned to a client. Never use
 * this class for infrastructure, provider payloads or arbitrary caught errors. */
export class PublicActionError extends Error {}
