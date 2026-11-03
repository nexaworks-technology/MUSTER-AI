import { UnfixturedRequestError } from "./fixture-transport";
import { ProviderHttpError, ProviderShapeError, ProviderUnreachableError } from "./transport";

/**
 * describeError base (spec §6B "errors in plain words"). Each adapter calls this with its own
 * name and the action a person should take for a rejected credential. The text is shown on
 * Settings › Integrations and stored as Integration.lastErrorPlain / SyncJob.errorPlain, so it
 * never contains a provider response body, a token or a stack trace.
 */
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
  if (err instanceof UnfixturedRequestError) return { plain: `Test transport: ${err.message}` };
  return { plain: `The ${provider} sync stopped because of an unexpected error.` };
}
