import { randomUUID } from "node:crypto";
import { env } from "@/lib/config/env";

/**
 * Optional error tracking (M12 B4, Q-20). With no ERROR_TRACKING_DSN it does nothing; the caller's
 * own log line is the record. With one, it POSTs a Sentry-compatible event to the DSN's store
 * endpoint over fetch (no SDK).
 *
 * Rule 8 / Q-20: what leaves is the error's SHAPE only: its type name, its stack frames (file,
 * function, line), the request or job id, the route or job name, the environment and the release.
 * Never the error message (it can hold record data or an address), request bodies, headers,
 * cookies, user emails or job data. The DSN is parsed here and never logged.
 */
export interface ErrorContext {
  requestId?: string;
  jobId?: string;
  queue?: string;
  job?: string;
  route?: string;
}

export interface ParsedDsn {
  endpoint: string;
  publicKey: string;
}

/** `https://<key>@<host>[/prefix]/<projectId>` → the store endpoint; null when malformed. */
export function parseDsn(dsn: string): ParsedDsn | null {
  try {
    const url = new URL(dsn);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.username) return null;
    const segments = url.pathname.split("/").filter(Boolean);
    const projectId = segments.pop();
    if (!projectId || !/^\d+$/.test(projectId)) return null;
    const prefix = segments.length ? `/${segments.join("/")}` : "";
    return {
      endpoint: `${url.protocol}//${url.host}${prefix}/api/${projectId}/store/`,
      publicKey: decodeURIComponent(url.username),
    };
  } catch {
    return null;
  }
}

interface Frame {
  filename: string;
  function?: string;
  lineno?: number;
  colno?: number;
  in_app: boolean;
}

const FRAME_WITH_FN = /^\s*at (?:async )?(.+?) \((.+):(\d+):(\d+)\)\s*$/;
const FRAME_BARE = /^\s*at (?:async )?(.+):(\d+):(\d+)\s*$/;
const MAX_FRAMES = 50;

/**
 * Repo-relative file (no home directory or username), with pnpm's `.pnpm/<pkg>@<version>/`
 * directory dropped so no `@` runs through the path.
 */
function cleanFile(file: string): string {
  let f = file.replace(/^file:\/\//, "");
  try {
    f = decodeURI(f);
  } catch {
    // keep as is
  }
  const nm = f.lastIndexOf("node_modules/");
  if (nm >= 0) return f.slice(nm).replace(/^node_modules\/\.pnpm\/[^/]+\//, "");
  const src = f.lastIndexOf("/src/");
  return src >= 0 ? f.slice(src + 1) : f.split("/").slice(-2).join("/");
}

/** Frames from a V8 stack, oldest call first (Sentry's order). The message line is never read. */
function framesOf(stack: string | undefined): Frame[] {
  if (!stack) return [];
  const frames: Frame[] = [];
  for (const line of stack.split("\n")) {
    const withFn = FRAME_WITH_FN.exec(line);
    const bare = withFn ? null : FRAME_BARE.exec(line);
    const m = withFn ?? bare;
    if (!m) continue;
    const [fn, file, l, c] = withFn ? [m[1], m[2], m[3], m[4]] : [undefined, m[1], m[2], m[3]];
    const filename = cleanFile(file ?? "");
    frames.push({
      filename,
      ...(fn ? { function: fn.slice(0, 120) } : {}),
      lineno: Number(l),
      colno: Number(c),
      in_app: !filename.includes("node_modules"),
    });
    if (frames.length >= MAX_FRAMES) break;
  }
  return frames.reverse();
}

const SAFE_TOKEN = /^[A-Za-z0-9_.:/\-[\]$@]{1,128}$/;
const safe = (v: string | undefined): string | undefined =>
  v !== undefined && SAFE_TOKEN.test(v) && !v.includes("@") ? v : undefined;

function typeOf(err: unknown): string {
  const name = err instanceof Error ? err.name : "NonError";
  return /^[A-Za-z0-9_$.]{1,80}$/.test(name) ? name : "Error";
}

export function buildEvent(
  err: unknown,
  context: ErrorContext,
  meta: { environment: string; release?: string },
): Record<string, unknown> {
  const tags = Object.fromEntries(
    Object.entries({
      request_id: safe(context.requestId),
      job_id: safe(context.jobId),
      queue: safe(context.queue),
      job: safe(context.job),
      route: safe(context.route),
    }).filter(([, v]) => v !== undefined),
  );
  const transaction = safe(context.route) ?? safe(context.job);
  return {
    event_id: randomUUID().replaceAll("-", ""),
    timestamp: Date.now() / 1000,
    platform: "node",
    level: "error",
    environment: meta.environment,
    ...(meta.release ? { release: meta.release } : {}),
    ...(transaction ? { transaction } : {}),
    tags,
    exception: {
      values: [
        {
          type: typeOf(err),
          stacktrace: { frames: framesOf(err instanceof Error ? err.stack : undefined) },
        },
      ],
    },
  };
}

export interface CaptureOptions {
  dsn: string | undefined;
  fetchFn?: typeof fetch;
  environment?: string;
  release?: string;
  timeoutMs?: number;
}

/** Injectable core: resolves once the send settled; never rejects. */
export async function captureErrorWith(
  err: unknown,
  context: ErrorContext,
  opts: CaptureOptions,
): Promise<void> {
  try {
    if (!opts.dsn) return;
    const parsed = parseDsn(opts.dsn);
    if (!parsed) return;
    const event = buildEvent(err, context, {
      environment: opts.environment ?? "production",
      release: opts.release,
    });
    await (opts.fetchFn ?? fetch)(parsed.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sentry-Auth": `Sentry sentry_version=7, sentry_client=nexaworks/1, sentry_key=${parsed.publicKey}`,
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 2_000),
    });
  } catch {
    // Tracking must never take the caller down; the caller has already logged the failure.
  }
}

/**
 * Report one error. Callers do not need to await it (`void captureError(...)`): it settles within
 * about two seconds and never throws.
 */
export function captureError(err: unknown, context: ErrorContext = {}): Promise<void> {
  try {
    const e = env();
    return captureErrorWith(err, context, {
      dsn: e.ERROR_TRACKING_DSN,
      environment: e.APP_ENV ?? e.NODE_ENV,
      release: e.APP_RELEASE,
    });
  } catch {
    return Promise.resolve();
  }
}
