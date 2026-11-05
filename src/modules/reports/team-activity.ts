import { teamLoad } from "@/modules/revenue/service";
import { count, missing, money } from "./figures";
import type { Figure, ReportContent } from "./types";

/**
 * Team activity vs outcomes (spec §6N, §6L). Per owner: accounts and ARR from `teamLoad()` (the
 * function behind the Revenue screen's team load), the work they did in the period (tasks done,
 * approvals decided) and what happened to the flags on their accounts at day 90 (the frozen
 * OutcomeRecord checkpoint). Flags not yet at day 90 are counted apart; they are not a bad
 * result. Activity is not blame: nothing here is a score of a person.
 */
export interface TeamActivityInput {
  baseCurrency: string;
  query: string;
  members: Array<{ id: string; name: string }>;
  accounts: Array<{
    id: string;
    ownerMembershipId: string | null;
    arrMinor: bigint | null;
    currency: string | null;
  }>;
  openTasks: Array<{ id: string; accountId: string | null; ownerMembershipId: string }>;
  doneTasks: Array<{ id: string; accountId: string | null; ownerMembershipId: string }>;
  decidedApprovals: Array<{ id: string; accountId: string | null; decidedById: string }>;
  outcomes: Array<{ id: string; accountId: string; d90Status: string | null }>;
}

const GOOD = new Set(["RENEWED", "RECOVERED", "EXPANDED"]);
const BAD = new Set(["CHURNED", "CONTRACTED"]);

export function teamActivityReport(i: TeamActivityInput): ReportContent {
  const openByOwner = new Map<string, number>();
  for (const t of i.openTasks)
    openByOwner.set(t.ownerMembershipId, (openByOwner.get(t.ownerMembershipId) ?? 0) + 1);
  const load = teamLoad(
    i.accounts.map((a) => ({
      id: a.id,
      ownerMembershipId: a.ownerMembershipId,
      arrMinor: a.arrMinor,
      currency: a.currency,
    })),
    openByOwner,
    i.baseCurrency,
  );
  const names = new Map(i.members.map((m) => [m.id, m.name]));
  const noFlags = "No flags were raised on this owner's accounts in the period.";
  const sections = load.map((l) => {
    const owner = l.ownerMembershipId;
    const who = owner ? (names.get(owner) ?? "Former member") : "No owner";
    const mine = i.accounts.filter((a) => a.ownerMembershipId === owner);
    const mineIds = new Set(mine.map((a) => a.id));
    const noArr = mine.filter((a) => a.arrMinor === null || a.currency === null);
    const flags = i.outcomes.filter((o) => mineIds.has(o.accountId));
    const pick = (f: (s: string) => boolean) =>
      flags.filter((o) => o.d90Status !== null && f(o.d90Status));
    const flagRow = (o: { id: string; accountId: string }) => ({
      id: o.id,
      accountId: o.accountId,
    });
    const figures: Figure[] = [
      count(
        `${who}: accounts`,
        "Account",
        mine.map((a) => ({ id: a.id, accountId: a.id })),
      ),
      count(
        `${who}: accounts with no ARR on file`,
        "Account",
        noArr.map((a) => ({ id: a.id, accountId: a.id })),
      ),
      mine.length === 0 || mine.length === noArr.length
        ? missing(`${who}: ARR owned`, "money", "Account", "No ARR on file for these accounts.")
        : money(
            `${who}: ARR owned`,
            l.arrMinor,
            i.baseCurrency,
            "Account",
            mine
              .filter((a) => a.currency === i.baseCurrency && a.arrMinor !== null)
              .map((a) => ({ id: a.id, accountId: a.id })),
            "No ARR on file for these accounts.",
          ),
    ];
    if (owner) {
      const tasks = (
        list: Array<{ id: string; accountId: string | null; ownerMembershipId: string }>,
      ) =>
        list
          .filter((t) => t.ownerMembershipId === owner)
          .map((t) => ({ id: t.id, accountId: t.accountId }));
      figures.push(
        count(`${who}: open tasks`, "Task", tasks(i.openTasks)),
        count(`${who}: tasks completed in the period`, "Task", tasks(i.doneTasks)),
        count(
          `${who}: approvals decided`,
          "Approval",
          i.decidedApprovals
            .filter((a) => a.decidedById === owner)
            .map((a) => ({ id: a.id, accountId: a.accountId })),
        ),
      );
    }
    figures.push(
      flags.length === 0
        ? missing(
            `${who}: flags that ended renewed or recovered`,
            "count",
            "OutcomeRecord",
            noFlags,
          )
        : count(
            `${who}: flags that ended renewed or recovered`,
            "OutcomeRecord",
            pick((s) => GOOD.has(s)).map(flagRow),
          ),
      flags.length === 0
        ? missing(
            `${who}: flags that ended in churn or contraction`,
            "count",
            "OutcomeRecord",
            noFlags,
          )
        : count(
            `${who}: flags that ended in churn or contraction`,
            "OutcomeRecord",
            pick((s) => BAD.has(s)).map(flagRow),
          ),
      flags.length === 0
        ? missing(`${who}: flags with another result at 90 days`, "count", "OutcomeRecord", noFlags)
        : count(
            `${who}: flags with another result at 90 days`,
            "OutcomeRecord",
            pick((s) => !GOOD.has(s) && !BAD.has(s)).map(flagRow),
          ),
      flags.length === 0
        ? missing(`${who}: flags not yet at 90 days`, "count", "OutcomeRecord", noFlags)
        : count(
            `${who}: flags not yet at 90 days`,
            "OutcomeRecord",
            flags.filter((o) => o.d90Status === null).map(flagRow),
          ),
    );
    return { title: who, figures };
  });

  return {
    notes: [
      "Flag outcomes are attributed to the flag from records up to day 90; they are not proof the work caused them.",
    ],
    sections,
  };
}
