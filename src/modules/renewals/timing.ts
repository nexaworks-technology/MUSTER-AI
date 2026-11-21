/**
 * When a renewal falls, in words. An open renewal past its date is overdue (DEMO-WALKTHROUGH
 * FAIL 29: the tab said "in -12 days").
 */
export function renewalTiming(daysToRenewal: number): string {
  if (daysToRenewal < 0)
    return `overdue by ${-daysToRenewal} day${daysToRenewal === -1 ? "" : "s"}`;
  if (daysToRenewal === 0) return "due today";
  return `in ${daysToRenewal} day${daysToRenewal === 1 ? "" : "s"}`;
}
