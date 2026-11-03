import type { CalendarDate } from "@/lib/dates";
import type { NormalizedUsageDay } from "../normalized";

/**
 * Events → one usage day per account (D-23: aggregates only). The Usage API's job and the
 * Mixpanel adapter fold the same way, so "what counts" is defined once:
 *
 * - every event is an event for its person and account that day;
 * - an event named like a session start (`session_started`, `Session Started`) is also a session;
 * - an event belongs to a feature when it names one (`feature`), or its own name is a key the
 *   caller knows (the workspace's feature catalogue).
 *
 * `SET` days (a tool that read the whole day) also state the day's active people.
 */
export interface FoldEvent {
  groupRef: string;
  userId: string;
  date: CalendarDate;
  name?: string;
  feature?: string;
}

export const normalizeEventName = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

export const isSessionStart = (name: string | undefined) => {
  const n = normalizeEventName(name ?? "");
  return n === "session_started" || n === "session_start";
};

export function foldUsage(
  events: FoldEvent[],
  opts: { mode: "SET" | "ADD"; known?: ReadonlySet<string>; emails?: ReadonlyMap<string, string> },
): NormalizedUsageDay[] {
  type Day = {
    day: NormalizedUsageDay;
    users: Map<string, { events: number; sessions: number }>;
    features: Map<string, { people: Set<string>; events: number }>;
  };
  const days = new Map<string, Day>();
  for (const e of events) {
    const key = `${e.groupRef}|${e.date}`;
    let d = days.get(key);
    if (!d) {
      d = {
        day: {
          accountExternalId: e.groupRef,
          date: e.date,
          mode: opts.mode,
          events: 0,
          sessions: 0,
          users: [],
          features: [],
        },
        users: new Map(),
        features: new Map(),
      };
      days.set(key, d);
    }
    const session = isSessionStart(e.name);
    d.day.events += 1;
    if (session) d.day.sessions += 1;
    const user = d.users.get(e.userId) ?? { events: 0, sessions: 0 };
    user.events += 1;
    if (session) user.sessions += 1;
    d.users.set(e.userId, user);
    const name = normalizeEventName(e.name ?? "");
    const feature = e.feature ?? (opts.known?.has(name) ? name : undefined);
    if (feature) {
      const f = d.features.get(feature) ?? { people: new Set<string>(), events: 0 };
      f.people.add(e.userId);
      f.events += 1;
      d.features.set(feature, f);
    }
  }
  return [...days.values()].map(({ day, users, features }) => ({
    ...day,
    activeUsers: opts.mode === "SET" ? users.size : undefined,
    users: [...users].map(([externalUserId, u]) => ({
      externalUserId,
      email: opts.emails?.get(externalUserId),
      ...u,
    })),
    features: [...features].map(([featureKey, f]) => ({
      featureKey,
      users: f.people.size,
      events: f.events,
    })),
  }));
}
