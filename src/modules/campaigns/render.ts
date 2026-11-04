/**
 * Campaign template merge fields: Account and Contact fields only (spec §6J2).
 */
export function renderCampaignText(
  template: string,
  context: {
    account: { name: string; [key: string]: unknown };
    contact: { name: string; email?: string | null; [key: string]: unknown };
  },
): string {
  let result = template;
  result = result.replace(/\{\{account\.name\}\}/g, context.account.name ?? "");
  result = result.replace(/\{\{contact\.name\}\}/g, context.contact.name ?? "");
  result = result.replace(
    /\{\{contact\.first_name\}\}/g,
    (context.contact.name ?? "").split(" ")[0] ?? "",
  );
  result = result.replace(/\{\{contact\.email\}\}/g, context.contact.email ?? "");
  return result;
}
