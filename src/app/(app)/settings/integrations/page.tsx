import type { Metadata } from "next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateTime } from "@/lib/format";
import {
  connectApiKeyAction,
  disconnectAction,
  runSyncNowAction,
  testConnectionAction,
  writeBackAction,
} from "@/modules/integrations/actions/integrations";
import { listIntegrations, type ProviderCard } from "@/modules/integrations/service";
import { requireSettingsAccess } from "../access";

export const metadata: Metadata = { title: "Integrations" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const STATUS: Record<"CONNECTED" | "ERROR" | "DISCONNECTED", string> = {
  CONNECTED: "Connected · read-only",
  ERROR: "Needs attention",
  DISCONNECTED: "Disconnected",
};

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
      ? `Connected ${cards.find((c) => c.provider.toLowerCase() === one(params.connected))?.name ?? ""}. It reads only; nothing is written back.`
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
    <div className="max-w-4xl space-y-6">
      <section aria-labelledby="integrations" className="space-y-2">
        <h2 id="integrations" className="text-base font-semibold">
          Integrations
        </h2>
        <p className="text-muted-foreground text-sm">
          Connect the tools your team already uses. Every connection reads only, unless you turn on
          write-back for a named field. Syncs run every night before health is scored, and you can
          run one now.
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
    <section aria-labelledby={headingId} className="border-border space-y-3 rounded-md border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={headingId} className="font-semibold">
          {card.name}{" "}
          <span className="text-muted-foreground text-xs font-normal">
            {card.category === "CRM" ? "CRM" : "Billing"}
          </span>
        </h3>
        <span className="text-sm" data-testid={`status-${card.provider}`}>
          {i ? STATUS[i.status] : "Not connected"}
        </span>
      </div>

      {i?.lastErrorPlain ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription data-testid={`error-${card.provider}`}>
            {i.lastErrorPlain}
          </AlertDescription>
        </Alert>
      ) : null}

      {connected ? <SyncStatus card={card} tz={tz} /> : null}

      {!connected ? <ConnectForm card={card} /> : null}

      {connected && i ? (
        <div className="flex flex-wrap gap-3">
          <form action={runSyncNowAction.bind(null, i.id)}>
            <Button type="submit">Run sync now</Button>
          </form>
          <form action={testConnectionAction.bind(null, i.id)}>
            <Button type="submit" variant="outline">
              Test connection
            </Button>
          </form>
        </div>
      ) : null}

      {connected && i?.webhookUrl ? (
        <p className="text-muted-foreground text-sm">
          Webhook address for {card.name} (payment events arrive in real time):{" "}
          <code className="break-all">{i.webhookUrl}</code>
        </p>
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
              <input type="checkbox" name="confirm" value="yes" className="size-4" />
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
          You will sign in to {card.name} and allow read access. Nothing is written back unless you
          turn it on later.
        </p>
        <a
          href={`/api/integrations/${card.provider.toLowerCase()}/connect`}
          className="bg-primary text-primary-foreground inline-flex h-9 items-center rounded-md px-4 text-sm"
        >
          Connect {card.name}
        </a>
      </div>
    );
  const p = card.provider;
  return (
    <form action={connectApiKeyAction.bind(null, p)} className="space-y-3">
      <p className="text-muted-foreground text-sm">{KEY_HELP[p]}</p>
      {p === "CHARGEBEE" ? (
        <div className="space-y-1">
          <Label htmlFor={`${p}-site`}>Site name</Label>
          <Input id={`${p}-site`} name="site" autoComplete="off" required />
        </div>
      ) : null}
      <div className="space-y-1">
        <Label htmlFor={`${p}-key`}>API key</Label>
        <Input id={`${p}-key`} name="apiKey" type="password" autoComplete="off" required />
      </div>
      {card.hasWebhooks ? (
        <div className="space-y-1">
          <Label htmlFor={`${p}-wh`}>
            Webhook signing secret (optional, for real-time payment events)
          </Label>
          <Input id={`${p}-wh`} name="webhookSecret" type="password" autoComplete="off" />
        </div>
      ) : null}
      <Button type="submit">Connect {card.name}</Button>
    </form>
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
            className="size-4"
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
                className="size-4"
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
