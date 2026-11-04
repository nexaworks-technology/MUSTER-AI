import { can } from "@/lib/auth/permissions";
import type { Actor } from "@/modules/accounts/service";

/**
 * The one decision about whether a member may see money (spec §6N5, INTERP-4), and the one way
 * to take money out of a row. `redactFinancials` (billing) and every M7 screen and query go
 * through here, so a new money field cannot be shown by forgetting a check: without revenue
 * access the money keys are removed entirely (not zeroed) and the row says `moneyVisible: false`.
 */
export type MoneyActor = Pick<Actor, "role" | "canViewRevenue" | "bookScope">;

export const canSeeMoney = (actor: MoneyActor): boolean => can(actor, "revenue:view") !== null;

export function redactMoney<T extends Record<string, unknown>, K extends keyof T>(
  actor: MoneyActor,
  row: T,
  moneyKeys: readonly K[],
): Omit<T, K> & Partial<Pick<T, K>> & { moneyVisible: boolean } {
  const visible = canSeeMoney(actor);
  const out: Record<string, unknown> = { ...row, moneyVisible: visible };
  if (!visible) for (const k of moneyKeys) delete out[k as string];
  return out as Omit<T, K> & Partial<Pick<T, K>> & { moneyVisible: boolean };
}
