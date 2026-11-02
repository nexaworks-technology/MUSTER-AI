/**
 * Resolves "@Full Name" mentions against the workspace's members. Matching is by whole name,
 * case-insensitive, longest name first, and must be followed by a non-word character.
 */
export function parseMentions(
  body: string,
  members: ReadonlyArray<{ membershipId: string; name: string }>,
): string[] {
  const byLength = [...members].sort((a, b) => b.name.length - a.name.length);
  const found = new Set<string>();
  const lower = body.toLowerCase();
  for (let i = lower.indexOf("@"); i !== -1; i = lower.indexOf("@", i + 1)) {
    if (i > 0 && /[\w.]/.test(lower[i - 1]!)) continue; // part of an email address
    const rest = lower.slice(i + 1);
    const hit = byLength.find((m) => {
      const name = m.name.toLowerCase();
      return rest.startsWith(name) && !/\w/.test(rest[name.length] ?? "");
    });
    if (hit) found.add(hit.membershipId);
  }
  return [...found];
}
