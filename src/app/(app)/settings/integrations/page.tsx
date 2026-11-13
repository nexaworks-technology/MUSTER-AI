import type { Metadata } from "next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { NativeSelect } from "@/components/app/native-select";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatDateTime } from "@/lib/format";
import {
  linkSlackMembersAction,
  connectApiKeyAction,
  disconnectAction,
  replaceApiKeyAction,
  runSyncNowAction,
  saveSegmentSecretAction,
  testConnectionAction,
  writeBackAction,
} from "@/modules/integrations/actions/integrations";
import { listIntegrations, type ProviderCard } from "@/modules/integrations/service";
import { requireSettingsAccess } from "../access";
import { UsageKeyPanel } from "./usage-key-panel";
import { PRODUCT_NAME } from "@/config/product";

export const metadata: Metadata = { title: "Integrations" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const STATUS: Record<"CONNECTED" | "ERROR" | "DISCONNECTED", string> = {
  // Data connectors read only (Rule 7); Slack is the exception and says so below (Q-56).
  CONNECTED: "Connected · read-only",
  ERROR: "Needs attention",
  DISCONNECTED: "Disconnected",
};

/** Slack sends messages to the team (never to customers), so it is never called read-only (Q-56). */
const statusLabel = (provider: string, status: keyof typeof STATUS) =>
  provider === "SLACK" && status === "CONNECTED"
    ? "Connected · messages your team"
    : provider === "USAGE_API" && status === "CONNECTED"
      ? "Connected · receives your events"
      : STATUS[status];

const CATEGORY: Record<string, string> = {
  CRM: "CRM",
  CHAT: "Team chat",
  USAGE: "Product usage",
  BILLING: "Billing",
  SUPPORT: "Support",
  EMAIL: "Email",
};

const connectedNotice = (provider: string, name: string) =>
  provider === "SLACK"
    ? "Connected Slack. It sends approvals, big signals and a morning digest to your team as direct messages; it never messages customers."
    : `Connected ${name}. It reads only; nothing is written back.`;

const OAUTH_ERRORS: Record<string, string> = {
  declined: "The sign-in was cancelled, so nothing was connected.",
  state:
    "That sign-in link could not be verified (it may have expired or come from another tab). Start again.",
  exchange: "The provider did not accept the sign-in. Start again.",
};

const KEY_HELP: Record<string, string> = {
  STRIPE:
    "Create a restricted key in Stripe with read access to Customers, Subscriptions and Invoices.",
  CHARGEBEE: "Create a read-only API key in Chargebee and enter your site name.",
  MIXPANEL:
    "Create a service account in Mixpanel (Project settings › Service accounts) with the Consumer role, and enter its user name, secret and your project id. We read event counts per account; events are folded into daily totals and not kept.",
  AMPLITUDE:
    "Enter the project's API key and secret key (Settings › Projects). We read daily totals per account through the Dashboard API; Amplitude cannot give us individual people, so the power-user list needs the Usage API or Mixpanel.",
  ZENDESK:
    "Enter your Zendesk subdomain, the admin email the token belongs to, and an API token (Admin Center › Apps and integrations › Zendesk API). We read tickets and comments read-only.",
  FRESHDESK:
    "Enter your Freshdesk domain and API key (Profile settings › View API key). We read tickets and conversations read-only.",
};

/** Key-form providers whose address needs the account's own name (sent as `site`). */
const SITE_LABEL: Record<string, string> = {
  CHARGEBEE: "Site name",
  ZENDESK: "Zendesk subdomain (the acme in acme.zendesk.com)",
  FRESHDESK: "Freshdesk domain (the acme in acme.freshdesk.com)",
};

/**
 * Settings › Integrations (M5, ARCHITECTURE §8.1, spec §6B). Admin only. Each connector shows
 * whether it is connected, when it last synced, what that run did (counts, and the records it
 * could not use, in plain words), and the last error in plain words. Write-back is off until an
 * Admin turns it on for named fields (Rule 7).
 */
export default async function IntegrationsPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await requireSettingsAccess("integrations:manage");
  const params = await searchParams;
  const cards = await listIntegrations(ctx);
  const tz = ctx.workspace.timezone;
  const error = one(params.error);
  const provider = one(params.provider);
  const notice = error
    ? (OAUTH_ERRORS[error] ?? error)
    : one(params.connected)
      ? (() => {
          const c = cards.find((x) => x.provider.toLowerCase() === one(params.connected));
          return connectedNotice(c?.provider ?? "", c?.name ?? "");
        })()
      : one(params.tested)
        ? one(params.tested)
        : one(params.queued)
          ? "Sync queued. Refresh in a moment to see the result."
          : one(params.disconnected)
            ? "Disconnected. Its saved credentials were deleted; synced records stay."
            : one(params.writeback)
              ? `Write-back is now ${one(params.writeback)}.`
              : null;

  return (
    <div className="space-y-section max-w-4xl">
      <section aria-labelledby="integrations" className="space-y-3">
        <h2 id="integrations" className="text-base font-semibold">
          Integrations
        </h2>
        <p className="text-muted-foreground text-sm">
          Connect the tools your team already uses. CRM and billing connections read only, unless
          you turn on write-back for a named field; syncs run every night before health is scored,
          and you can run one now. Slack sends direct messages to your team, never to customers.
        </p>
        {notice ? (
          <Alert variant={error ? "destructive" : "default"} role={error ? "alert" : "status"}>
            <AlertDescription>
              {provider && error ? `${provider}: ` : ""}
              {notice}
            </AlertDescription>
          </Alert>
        ) : null}
      </section>
      <ul className="space-y-4">
        {cards.map((card) => (
          <li key={card.provider}>
            <ProviderSection card={card} tz={tz} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProviderSection({ card, tz }: { card: ProviderCard; tz: string }) {
  const i = card.integration;
  const connected = i && i.status !== "DISCONNECTED";
  const headingId = `int-${card.provider}`;
  return (
    <section aria-labelledby={headingId} className="surface space-y-3 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={headingId} className="font-semibold">
          {card.name}{" "}
          <span className="text-muted-foreground text-xs font-normal">
            {CATEGORY[card.category] ?? "Billing"}
          </span>
        </h3>
        <span className="text-sm" data-testid={`status-${card.provider}`}>
          {i ? statusLabel(card.provider, i.status) : "Not connected"}
        </span>
      </div>

      {i?.lastErrorPlain ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription data-testid={`error-${card.provider}`}>
            {i.lastErrorPlain}
          </AlertDescription>
        </Alert>
      ) : null}

      {connected && card.provider === "USAGE_API" ? <UsageApiStatus card={card} tz={tz} /> : null}
      {connected && card.provider !== "SLACK" && card.provider !== "USAGE_API" ? (
        <SyncStatus card={card} tz={tz} />
      ) : null}
      {connected && card.provider === "SLACK" ? (
        <p className="text-sm" data-testid="slack-linked">
          {card.slackLinked} member{card.slackLinked === 1 ? "" : "s"} linked by verified email.
          Approvals, big signals and a morning digest (from 07:00) go to them as direct messages.
          Sensitive approvals show &quot;Open in app to review&quot; and cannot be decided from
          Slack.
        </p>
      ) : null}

      {card.provider === "USAGE_API" ? (
        <UsageApiPanel card={card} tz={tz} connected={Boolean(connected)} />
      ) : null}

      {!connected && card.provider !== "USAGE_API" ? <ConnectForm card={card} /> : null}

      {connected && i && card.provider !== "USAGE_API" ? (
        <div className="flex flex-wrap gap-3">
          {card.provider === "SLACK" ? (
            <form action={linkSlackMembersAction}>
              <Button type="submit">Link Slack members</Button>
            </form>
          ) : (
            <form action={runSyncNowAction.bind(null, i.id)}>
              <Button type="submit">Run sync now</Button>
            </form>
          )}
          <form action={testConnectionAction.bind(null, i.id)}>
            <Button type="submit" variant="outline">
              Test connection
            </Button>
          </form>
        </div>
      ) : null}

      {connected && i?.webhookUrl ? (
        <p className="text-muted-foreground text-sm">
          Webhook address for {card.name} ({card.category === "SUPPORT" ? "ticket" : "payment"}{" "}
          events arrive in real time): <code className="break-all">{i.webhookUrl}</code>
        </p>
      ) : null}

      {connected && i && card.authKind === "apiKey" && card.provider !== "USAGE_API" ? (
        <ReplaceKey card={card} />
      ) : null}

      {connected && i && card.writeBackFields.length > 0 ? <WriteBack card={card} /> : null}

      {connected && i ? (
        <details>
          <summary className="cursor-pointer text-sm">Disconnect {card.name}</summary>
          <form
            action={disconnectAction.bind(null, i.id)}
            className="mt-2 flex flex-wrap items-center gap-3"
          >
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="confirm" value="yes" className="accent-primary size-4" />
              Delete the saved credentials. Records already synced stay.
            </label>
            <Button type="submit" variant="destructive" size="sm">
              Disconnect
            </Button>
          </form>
        </details>
      ) : null}
    </section>
  );
}

function UsageApiStatus({ card, tz }: { card: ProviderCard; tz: string }) {
  const u = card.usageApi!;
  if (!u.lastBatch)
    return (
      <p className="text-sm" data-testid="usage-last-batch">
        No events have been applied yet. Send one with your key, below.
      </p>
    );
  return (
    <div className="space-y-1 text-sm" data-testid="usage-last-batch">
      <p>
        Last batch applied {formatDateTime(u.lastBatch.appliedAt, tz)}: {u.lastBatch.events} event
        {u.lastBatch.events === 1 ? "" : "s"} folded into daily totals and discarded. {u.batches}{" "}
        batch{u.batches === 1 ? "" : "es"} in all.
      </p>
      {u.lastBatch.unmatched.length > 0 ? (
        <details>
          <summary className="cursor-pointer">
            {u.lastBatch.unmatched.length} group{u.lastBatch.unmatched.length === 1 ? "" : "s"}{" "}
            matched no account
          </summary>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {u.lastBatch.unmatched.map((m, n) => (
              <li key={n}>{m.reason}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {u.lastBatch.skipped.length > 0 ? (
        <details>
          <summary className="cursor-pointer">
            {u.lastBatch.skipped.length} day{u.lastBatch.skipped.length === 1 ? "" : "s"} left as
            they were
          </summary>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {u.lastBatch.skipped.map((m, n) => (
              <li key={n}>{m}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function UsageApiPanel({
  card,
  tz,
  connected,
}: {
  card: ProviderCard;
  tz: string;
  connected: boolean;
}) {
  const u = card.usageApi!;
  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-sm">
        Send product events from your own backend, or through Segment. Events are folded into daily
        totals per account, person and feature, then discarded: we do not keep raw events, so event
        level questions need your own analytics tool. Send them to{" "}
        <code className="break-all">{u.endpoint}/track</code>, <code>/identify</code> or{" "}
        <code>/batch</code> with <code>Authorization: Bearer &lt;key&gt;</code>. Each event needs a
        <code> userId</code> and a <code>groupId</code> that matches an account (by account id, CRM
        id or domain).
      </p>
      <UsageKeyPanel
        last4={u.keyLast4}
        rotatedAtText={u.keyRotatedAt ? formatDateTime(u.keyRotatedAt, tz) : null}
      />
      <details>
        <summary className="cursor-pointer text-sm">
          Segment: {u.hasSegmentSecret ? "shared secret saved" : "no shared secret yet"}
        </summary>
        <form action={saveSegmentSecretAction} className="mt-2 space-y-2">
          <p className="text-muted-foreground text-sm">
            Add a Webhooks destination in Segment pointing at{" "}
            <code className="break-all">{u.segmentUrl ?? `${u.endpoint}/batch?integration=…`}</code>{" "}
            with a shared secret, and enter the same secret here. Segment signs each request with it
            and we check the signature.
          </p>
          <div className="space-y-1">
            <Label htmlFor="usage-segment-secret">Shared secret</Label>
            <Input
              id="usage-segment-secret"
              name="secret"
              type="password"
              autoComplete="off"
              minLength={8}
              required
            />
          </div>
          <Button type="submit" variant="outline" size="sm">
            Save shared secret
          </Button>
        </form>
      </details>
      {connected ? null : (
        <p className="text-muted-foreground text-sm">
          Nothing is connected until you generate a key or save a Segment secret.
        </p>
      )}
    </div>
  );
}

function SyncStatus({ card, tz }: { card: ProviderCard; tz: string }) {
  const run = card.lastRun;
  const i = card.integration!;
  if (!run)
    return <p className="text-sm">No sync has run yet. Run one now, or wait for tonight&apos;s.</p>;
  const c = run.counts;
  const parts = [
    `${c.created} added`,
    `${c.updated} updated`,
    `${c.unchanged} unchanged`,
    c.conflicts ? `${c.conflicts} conflicting values left for you (Data quality)` : null,
    c.unmatched ? `${c.unmatched} not matched` : null,
    c.rejected ? `${c.rejected} skipped as invalid` : null,
  ].filter(Boolean);
  return (
    <div className="space-y-1 text-sm" data-testid={`sync-${card.provider}`}>
      <p>
        Last sync{" "}
        {run.status === "RUNNING"
          ? `started ${formatDateTime(run.startedAt, tz)} and is still running`
          : `${run.status === "SUCCEEDED" ? "finished" : "failed"} ${formatDateTime(run.finishedAt ?? run.startedAt, tz)}`}
        {run.trigger === "NIGHTLY" ? " (nightly)" : ""}.{" "}
        {run.status !== "RUNNING" ? `${parts.join(", ")}.` : null}
      </p>
      {run.status === "FAILED" && run.errorPlain ? <p>{run.errorPlain}</p> : null}
      {i.lastSyncAt && run.status !== "SUCCEEDED" ? (
        <p className="text-muted-foreground">
          Last successful sync: {formatDateTime(i.lastSyncAt, tz)}.
        </p>
      ) : null}
      {c.problems.length > 0 ? (
        <details>
          <summary className="cursor-pointer">
            {c.problems.length} record{c.problems.length === 1 ? "" : "s"} could not be used
          </summary>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {c.problems.map((p, n) => (
              <li key={n}>{p.reason}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function ConnectForm({ card }: { card: ProviderCard }) {
  if (card.authKind === "oauth2")
    return (
      <div className="space-y-2">
        <p className="text-sm">
          {card.provider === "SLACK"
            ? `You will add the ${PRODUCT_NAME} app to your Slack. It reads member emails to link your team and sends them direct messages; it never messages customers.`
            : `You will sign in to ${card.name} and allow read access. Nothing is written back unless you turn it on later.`}
        </p>
        <a
          href={`/api/integrations/${card.provider.toLowerCase()}/connect`}
          className={buttonVariants()}
        >
          Connect {card.name}
        </a>
      </div>
    );
  const p = card.provider;
  const usage = p === "MIXPANEL" || p === "AMPLITUDE";
  return (
    <form action={connectApiKeyAction.bind(null, p)} className="space-y-3">
      <p className="text-muted-foreground text-sm">{KEY_HELP[p]}</p>
      {usage ? (
        <div className="space-y-1">
          <Label htmlFor={`${p}-user`}>
            {p === "MIXPANEL" ? "Service account user name" : "API key"}
          </Label>
          <Input id={`${p}-user`} name="username" autoComplete="off" required />
        </div>
      ) : null}
      {p === "MIXPANEL" ? (
        <div className="space-y-1">
          <Label htmlFor={`${p}-project`}>Project id</Label>
          <Input
            id={`${p}-project`}
            name="projectId"
            inputMode="numeric"
            autoComplete="off"
            required
          />
        </div>
      ) : null}
      {usage ? (
        <div className="space-y-1">
          <Label htmlFor={`${p}-region`}>Data region</Label>
          <NativeSelect id={`${p}-region`} name="region" defaultValue="US">
            <option value="US">US</option>
            <option value="EU">EU</option>
          </NativeSelect>
        </div>
      ) : null}
      {usage ? (
        <div className="space-y-1">
          <Label htmlFor={`${p}-account`}>
            {p === "MIXPANEL"
              ? "Event property that holds the account (default account_id)"
              : "Property that holds the account (default gp:account_id)"}
          </Label>
          <Input id={`${p}-account`} name="accountProperty" autoComplete="off" />
        </div>
      ) : null}
      {p === "MIXPANEL" ? (
        <div className="space-y-1">
          <Label htmlFor={`${p}-feature`}>
            Event property that names the feature (default feature)
          </Label>
          <Input id={`${p}-feature`} name="featureProperty" autoComplete="off" />
        </div>
      ) : null}
      {p === "AMPLITUDE" ? (
        <div className="space-y-1">
          <Label htmlFor={`${p}-features`}>
            Features: one per line, as feature_key=Amplitude event name (optional)
          </Label>
          <Textarea
            id={`${p}-features`}
            name="features"
            rows={3}
            placeholder="dashboards=Dashboard Viewed"
          />
        </div>
      ) : null}
      {SITE_LABEL[p] ? (
        <div className="space-y-1">
          <Label htmlFor={`${p}-site`}>{SITE_LABEL[p]}</Label>
          <Input
            id={`${p}-site`}
            name="site"
            autoComplete="off"
            required
            placeholder={p === "CHARGEBEE" ? "acme-test" : "acme"}
          />
        </div>
      ) : null}
      {p === "ZENDESK" ? (
        <div className="space-y-1">
          <Label htmlFor={`${p}-user`}>Admin email (the user the API token belongs to)</Label>
          <Input id={`${p}-user`} name="username" type="email" autoComplete="off" required />
        </div>
      ) : null}
      <div className="space-y-1">
        <Label htmlFor={`${p}-key`}>
          {p === "MIXPANEL"
            ? "Service account secret"
            : p === "AMPLITUDE"
              ? "Secret key"
              : "API key"}
        </Label>
        <Input id={`${p}-key`} name="apiKey" type="password" autoComplete="off" required />
      </div>
      {card.hasWebhooks ? (
        <div className="space-y-1">
          <Label htmlFor={`${p}-wh`}>
            {p === "CHARGEBEE"
              ? "Webhook username:password, the same as on the Chargebee webhook (optional, for real-time payment events)"
              : card.category === "SUPPORT"
                ? "Webhook secret (optional, for real-time ticket events)"
                : "Webhook signing secret (optional, for real-time payment events)"}
          </Label>
          <Input id={`${p}-wh`} name="webhookSecret" type="password" autoComplete="off" />
        </div>
      ) : null}
      <Button type="submit">Connect {card.name}</Button>
    </form>
  );
}

/**
 * Replace the saved key without disconnecting (CONNECTOR-LIVE.md, B1 finding 3). Open by default
 * when the card needs attention, since the error asks for a new key. Settings, webhook secret and
 * synced records stay; the new key is checked with the provider before it replaces the old one.
 */
function ReplaceKey({ card }: { card: ProviderCard }) {
  const i = card.integration!;
  const p = card.provider;
  const label =
    p === "MIXPANEL"
      ? "New service account secret"
      : p === "AMPLITUDE"
        ? "New secret key"
        : "New API key";
  return (
    <details open={i.status === "ERROR"} data-testid={`replace-key-${p}`}>
      <summary className="cursor-pointer text-sm">Replace the {card.name} key</summary>
      <form action={replaceApiKeyAction.bind(null, i.id)} className="mt-2 space-y-3">
        <p className="text-muted-foreground text-sm">
          {card.name} checks the new key first; only an accepted key replaces the saved one. The
          connection, its settings and every synced record stay as they are.
        </p>
        <div className="space-y-1">
          <Label htmlFor={`${p}-new-key`}>{label}</Label>
          <Input id={`${p}-new-key`} name="apiKey" type="password" autoComplete="off" required />
        </div>
        <Button type="submit" variant="outline">
          Check and replace key
        </Button>
      </form>
    </details>
  );
}

function WriteBack({ card }: { card: ProviderCard }) {
  const i = card.integration!;
  return (
    <details>
      <summary className="cursor-pointer text-sm">
        Write-back to {card.name}: {i.writeBackEnabled ? "on" : "off"}
      </summary>
      <form action={writeBackAction.bind(null, i.id)} className="mt-2 space-y-2">
        <p className="text-muted-foreground text-sm">
          Off by default. When on, changes to the fields you tick can be written to {card.name},
          each one only after someone approves it.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="enabled"
            defaultChecked={i.writeBackEnabled}
            className="accent-primary size-4"
          />
          Allow write-back
        </label>
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">Fields</legend>
          {card.writeBackFields.map((f) => (
            <label key={f.key} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="fields"
                value={f.key}
                defaultChecked={i.writeBackFields.includes(f.key)}
                className="accent-primary size-4"
              />
              {f.label}
            </label>
          ))}
        </fieldset>
        <Button type="submit" variant="outline" size="sm">
          Save write-back
        </Button>
      </form>
    </details>
  );
}
