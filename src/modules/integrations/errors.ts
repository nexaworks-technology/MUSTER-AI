import { UnfixturedRequestError } from "./fixture-transport";
import { ProviderHttpError, ProviderShapeError, ProviderUnreachableError } from "./transport";

/**
 * describeError base (spec §6B "errors in plain words"). Each adapter calls this with its own
 * name and the action a person should take for a rejected credential. The text is shown on
 * Settings › Integrations and stored as Integration.lastErrorPlain / SyncJob.errorPlain, so it
 * never contains a provider response body, a token or a stack trace.
 */
/**
 * An OAuth token endpoint refused the client credentials (Zendesk client_credentials: the client was
 * revoked or deleted, or the secret is wrong). A credential problem, so the card shows "Needs
 * attention". Carries only the HTTP status: never the client secret or the provider's body.
 */
export class OAuthClientRefusedError extends Error {
  constructor(readonly status: number) {
    super(`The OAuth token endpoint refused the client (HTTP ${status})`);
    this.name = "OAuthClientRefusedError";
  }
}

/**
 * A connection is missing a setting its provider address or sign-in needs (a Zendesk subdomain
 * or admin email, a Freshdesk domain). Thrown before any request, so nothing is ever sent to a
 * guessed address (CONNECTOR-LIVE.md, Zendesk/Freshdesk blocker 1).
 */
export class ConnectionSettingMissingError extends Error {
  constructor(
    readonly provider: string,
    readonly setting: string,
  ) {
    super(`${provider} is missing its ${setting}`);
    this.name = "ConnectionSettingMissingError";
  }
}

export interface PlainError {
  plain: string;
  action?: string;
}

export function describeProviderError(
  err: unknown,
  provider: string,
  credentialAction: string,
): PlainError {
  if (err instanceof ProviderHttpError) {
    if (err.status === 401)
      return {
        plain: `${provider} rejected the saved credentials.`,
        action: credentialAction,
      };
    if (err.status === 403)
      return {
        plain: `${provider} refused access: the connection is missing a permission it needs.`,
        action: `Reconnect ${provider} and allow read access to the listed objects.`,
      };
    if (err.status === 404)
      return {
        plain: `${provider} could not find something the sync asked for.`,
        action: "Run the sync again. If it keeps failing, reconnect the integration.",
      };
    if (err.status === 429)
      return {
        plain: `${provider} asked us to slow down (rate limit)${err.retryAfterSeconds ? `; it will accept requests again in about ${err.retryAfterSeconds} seconds` : ""}.`,
        action: "Nothing to do: the next run picks up where this one stopped.",
      };
    if (err.status >= 500)
      return {
        plain: `${provider} had a problem on its side (HTTP ${err.status}).`,
        action: "Nothing to do: the next run tries again.",
      };
    return { plain: `${provider} refused the request (HTTP ${err.status}).` };
  }
  if (err instanceof ProviderUnreachableError)
    return {
      plain: `${provider} could not be reached.`,
      action: "Nothing to do: the next run tries again.",
    };
  if (err instanceof ProviderShapeError)
    return {
      plain: `${provider} sent data in a shape we did not expect, so nothing from that page was saved.`,
      action: "We have been told. The next run tries again.",
    };
  if (err instanceof ConnectionSettingMissingError)
    return {
      plain: `${err.provider} is missing its ${err.setting}, so nothing was requested.`,
      action: `Disconnect ${err.provider} and connect it again: ${credentialAction}`,
    };
  if (err instanceof UnfixturedRequestError) return { plain: `Test transport: ${err.message}` };
  return { plain: `The ${provider} sync stopped because of an unexpected error.` };
}
