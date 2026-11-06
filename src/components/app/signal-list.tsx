import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/app/empty-state";
import { formatCalendarDate } from "@/lib/format";
import { SignalActions } from "./signal-actions";
import {
  CATEGORY_WORDS,
  outsideLabel,
  SEVERITY_WORDS,
  STATUS_WORDS,
} from "@/modules/signals/schemas";

/** One list for the account Signals tab and the portfolio (spec §6D: each signal explains itself). */
export interface SignalRow {
  id: string;
  accountId: string;
  account?: { name: string };
  ruleKey: string;
  category: keyof typeof CATEGORY_WORDS;
  severity: keyof typeof SEVERITY_WORDS;
  polarity: "RISK" | "OPPORTUNITY";
  status: keyof typeof STATUS_WORDS;
  title: string;
  explanation: string;
  episode: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  resolvedReason: string | null;
  falseAlarmReason: string | null;
  publicSourceUrl: string | null;
  publicSourceDate: Date | null;
  evidenceLinks: Array<{ label: string; href: string | null; missing: boolean }>;
}
export interface RuleFields {
  meaning: string;
  howDetected: string;
  typicalLeadTime: string;
  falseAlarmCauses: string;
}

const SEVERITY_VARIANT = { CRITICAL: "danger", WARN: "warning", INFO: "neutral" } as const;

export function SignalList({
  signals,
  rules,
  canAct,
  showAccount = false,
  today,
}: {
  signals: SignalRow[];
  rules: Map<string, RuleFields>;
  canAct: (s: SignalRow) => boolean;
  showAccount?: boolean;
  /** The workspace's today: outside events older than 30 days read "Reported <date>", never "New". */
  today: string;
}) {
  if (signals.length === 0) return <EmptyState>No signals match.</EmptyState>;
  return (
    <ul className="surface divide-border divide-y overflow-hidden" aria-label="Signals">
      {signals.map((s) => {
        const live = s.status === "OPEN" || s.status === "ACKNOWLEDGED";
        const rule = rules.get(s.ruleKey);
        return (
          <li
            key={s.id}
            id={`signal-${s.id}`}
            className="target:bg-muted scroll-mt-4 space-y-2 p-4 text-sm"
            data-testid="signal"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={SEVERITY_VARIANT[s.severity]}>{SEVERITY_WORDS[s.severity]}</Badge>
              {s.polarity === "OPPORTUNITY" ? <Badge variant="success">Opportunity</Badge> : null}
              <span className="font-medium">{s.title}</span>
              {showAccount && s.account ? (
                <Link
                  href={`/accounts/${s.accountId}/signals#signal-${s.id}`}
                  className="text-primary underline underline-offset-2"
                >
                  {s.account.name}
                </Link>
              ) : null}
            </div>
            <p>{s.explanation}</p>
            <p className="text-muted-foreground text-xs">
              {CATEGORY_WORDS[s.category]} · {STATUS_WORDS[s.status]} · episode {s.episode} · first
              seen {formatCalendarDate(s.firstSeenAt)} · last seen{" "}
              {formatCalendarDate(s.lastSeenAt)}
              {s.publicSourceDate
                ? ` · ${outsideLabel(s.publicSourceDate.toISOString().slice(0, 10), today, 30)}`
                : ""}
            </p>
            {s.resolvedReason ? (
              <p className="text-muted-foreground text-xs">{s.resolvedReason}</p>
            ) : null}
            {s.falseAlarmReason ? (
              <p className="text-muted-foreground text-xs">False alarm: {s.falseAlarmReason}</p>
            ) : null}
            {live ? (
              <p className="text-xs">
                <Link
                  href={`/approvals/new?sourceType=Signal&sourceId=${s.id}`}
                  className="text-primary underline underline-offset-2"
                  data-testid="draft-check-in"
                >
                  Draft check-in
                </Link>
              </p>
            ) : null}
            <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs" aria-label="Evidence">
              {s.publicSourceUrl ? (
                <li>
                  <a
                    href={s.publicSourceUrl}
                    className="text-primary underline underline-offset-2"
                    rel="noopener noreferrer nofollow"
                    target="_blank"
                  >
                    Public source
                  </a>
                </li>
              ) : null}
              {s.evidenceLinks.map((e, i) => (
                <li key={i}>
                  {e.href ? (
                    <a href={e.href} className="text-primary underline underline-offset-2">
                      {e.label}
                    </a>
                  ) : (
                    <span className="text-muted-foreground">{e.label}</span>
                  )}
                </li>
              ))}
            </ul>
            {rule ? (
              <details className="text-xs">
                <summary className="text-muted-foreground cursor-pointer">
                  About this signal
                </summary>
                <dl className="mt-1 grid gap-x-3 gap-y-1 sm:grid-cols-[max-content_1fr]">
                  <dt className="font-medium">What it means</dt>
                  <dd>{rule.meaning}</dd>
                  <dt className="font-medium">How we detect it</dt>
                  <dd>{rule.howDetected}</dd>
                  <dt className="font-medium">How early it appears</dt>
                  <dd>{rule.typicalLeadTime}</dd>
                  <dt className="font-medium">What can make it a false alarm</dt>
                  <dd>{rule.falseAlarmCauses}</dd>
                </dl>
              </details>
            ) : null}
            {live && canAct(s) ? (
              <SignalActions signalId={s.id} title={s.title} status={s.status} />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
