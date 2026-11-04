/**
 * Team load (spec §6N): per CSM, how many accounts, how much ARR (base currency; other
 * currencies listed apart, never converted; accounts with no ARR on file counted separately) and
 * how many open tasks. Accounts with no owner are their own row. Pure.
 */
export interface LoadAccount {
  id: string;
  ownerMembershipId: string | null;
  arrMinor: bigint | null;
  currency: string | null;
}

export interface LoadRow {
  ownerMembershipId: string | null;
  accounts: number;
  arrMinor: bigint;
  accountsWithoutArr: number;
  otherCurrencies: Array<{ currency: string; arrMinor: bigint }>;
  openTasks: number;
}

export function teamLoad(
  accounts: readonly LoadAccount[],
  openTasksByOwner: ReadonlyMap<string, number>,
  baseCurrency: string,
): LoadRow[] {
  const rows = new Map<string | null, LoadRow & { other: Map<string, bigint> }>();
  const row = (k: string | null) => {
    let r = rows.get(k);
    if (!r) {
      r = {
        ownerMembershipId: k,
        accounts: 0,
        arrMinor: 0n,
        accountsWithoutArr: 0,
        otherCurrencies: [],
        openTasks: k ? (openTasksByOwner.get(k) ?? 0) : 0,
        other: new Map(),
      };
      rows.set(k, r);
    }
    return r;
  };
  for (const k of openTasksByOwner.keys()) row(k);
  for (const a of accounts) {
    const r = row(a.ownerMembershipId);
    r.accounts++;
    if (a.arrMinor === null || a.currency === null) r.accountsWithoutArr++;
    else if (a.currency === baseCurrency) r.arrMinor += a.arrMinor;
    else r.other.set(a.currency, (r.other.get(a.currency) ?? 0n) + a.arrMinor);
  }
  return [...rows.values()]
    .map(({ other, ...r }) => ({
      ...r,
      otherCurrencies: [...other]
        .sort(([x], [y]) => x.localeCompare(y))
        .map(([currency, arrMinor]) => ({ currency, arrMinor })),
    }))
    .sort((a, b) =>
      a.arrMinor === b.arrMinor ? b.accounts - a.accounts : a.arrMinor > b.arrMinor ? -1 : 1,
    );
}
