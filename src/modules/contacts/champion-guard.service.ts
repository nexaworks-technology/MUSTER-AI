import { todayIn, businessClock, type CalendarDate } from "@/lib/dates";
import { scopedDb, type TenantContext } from "@/lib/db/scoped";
import { getOwnWorkspace } from "@/lib/db/workspace";
import {
  championState,
  currentHolder,
  formatDay,
  loadBundles,
  loadContext,
  rolesKnown,
  validOn,
} from "@/modules/health/service";
import { getAccount, type Actor } from "@/modules/accounts/service";
import { rankCandidates, type Candidate, type CandidatePerson } from "./champion-candidates";

/**
 * The Champion Guard card's read model (M9 B4): present only when the champion is gone or silent
 * (the one definition, health/champion.ts, D-119). Candidates are ranked by code from the same
 * bundle the signals read.
 */
export interface ChampionGuard {
  champion: {
    contactId: string;
    name: string;
    state: "GONE" | "SILENT";
    silentDays: number | null;
  };
  reason: string;
  candidates: Candidate[];
}

const SILENT_AFTER_DEFAULT = 30;

async function silentAfterDays(ctx: TenantContext): Promise<number> {
  const row = await scopedDb(ctx).signalRule.findFirst({
    where: { ruleKey: "champion_silent" },
    select: { params: true },
  });
  const n = (row?.params as { silentAfterDays?: unknown } | null)?.silentAfterDays;
  return typeof n === "number" && n >= 1 ? n : SILENT_AFTER_DEFAULT;
}

/** Without a permission check: for the agent. The screen goes through `loadChampionGuard`. */
export async function championGuardFor(
  ctx: TenantContext,
  accountId: string,
  asOf: CalendarDate,
): Promise<ChampionGuard | null> {
  const db = scopedDb(ctx);
  const bundle = (await loadBundles(db, await loadContext(ctx), asOf, [accountId])).get(accountId);
  if (!bundle) return null;
  const cs = championState(bundle, await silentAfterDays(ctx));
  if (!cs || cs.state === "ACTIVE") return null;
  const contacts = await db.contact.findMany({
    where: { accountId },
    select: { id: true, name: true, title: true, email: true },
  });
  const detail = new Map(contacts.map((c) => [c.id, c]));
  const from30 = new Date(`${asOf}T00:00:00Z`);
  from30.setUTCDate(from30.getUTCDate() - 29);
  const since = from30.toISOString().slice(0, 10);
  const roles = rolesKnown(bundle).filter((r) => validOn(r, asOf));
  const people: CandidatePerson[] = bundle.contacts.map((c) => {
    const d = detail.get(c.id);
    const days = new Set(
      (bundle.userUsage ?? [])
        .filter((u) => u.contactId === c.id && u.events > 0 && u.date >= since && u.date <= asOf)
        .map((u) => u.date),
    );
    return {
      id: c.id,
      name: c.name,
      title: d?.title ?? null,
      email: d?.email ?? null,
      status: c.status,
      roles: roles.filter((r) => r.contactId === c.id).map((r) => ({ id: r.id, role: r.role })),
      inbound: (bundle.messages ?? [])
        .filter((m) => m.fromContactId === c.id && m.direction === "INBOUND" && m.date <= asOf)
        .map((m) => ({ id: m.id, date: m.date })),
      activeDaysLast30: days.size,
    };
  });
  const gone = bundle.contacts.find((c) => c.id === cs.contactId);
  const holder = currentHolder(bundle, "CHAMPION");
  const reason =
    cs.state === "SILENT"
      ? `${cs.name}, the recorded champion, has not been heard from for ${cs.silentDays} days${cs.lastHeard ? ` (last on ${formatDay(cs.lastHeard)})` : ""}.`
      : gone?.status === "BOUNCED"
        ? `${cs.name}, the recorded champion, has an email that bounced${gone.statusDate ? ` on ${formatDay(gone.statusDate)}` : ""}.`
        : gone?.status === "LEFT"
          ? `${cs.name}, the recorded champion, has left the company${gone.statusDate ? ` (${formatDay(gone.statusDate)})` : ""}.`
          : holder
            ? `${cs.name} no longer counts as the champion.`
            : `${cs.name} no longer holds the champion role.`;
  return {
    champion: {
      contactId: cs.contactId,
      name: cs.name,
      state: cs.state,
      silentDays: cs.silentDays,
    },
    reason,
    candidates: rankCandidates({ asOf, accountId, goneContactId: cs.contactId, people }),
  };
}

export async function loadChampionGuard(
  actor: Actor,
  accountId: string,
  asOf?: CalendarDate,
): Promise<ChampionGuard | null> {
  if (!(await getAccount(actor, accountId))) return null;
  const date = asOf ?? todayIn((await getOwnWorkspace(actor)).timezone, businessClock);
  return championGuardFor(actor, accountId, date);
}
