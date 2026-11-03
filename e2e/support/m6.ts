import { inWorkspace, runScript } from "./m4";

/**
 * M6 e2e support. As in M4, the app under test has no AI key, so the two M6 agents run here, before
 * the browser steps, through the real consumer/executor on the RECORDED transport
 * (scripts/recorded-onboarding.ts: fixture answers composed from the records; no live model).
 * The app then shows what those runs stored, exactly as it would show live runs. `nonce` gives the
 * run its own triggers, so each e2e run drafts its own pending approvals (re-seeded, never reset).
 */
export function prepareM6(workspace: string, nonce: string): string {
  return runScript("scripts/recorded-onboarding.ts", ["--workspace", workspace, "--nonce", nonce], {
    AI_PROVIDER: "recorded",
    AI_RECORDINGS_DIR: ".dev-recordings/e2e",
  });
}

/** Forgets earlier Usage API traffic in a workspace (its key, batches and the rows it wrote). */
export async function resetUsageApi(workspace: string) {
  await inWorkspace(workspace, async (tx, workspaceId) => {
    const where = { workspaceId, source: "USAGE_API" as const };
    await tx.featureUsageDaily.deleteMany({ where });
    await tx.userUsageDaily.deleteMany({ where });
    await tx.usageDaily.deleteMany({ where });
    // The group → account mappings the Usage API learned point at the integration: they go first.
    await tx.externalRef.deleteMany({ where: { workspaceId, source: "USAGE_API" } });
    await tx.integration.deleteMany({ where: { workspaceId, provider: "USAGE_API" } });
  });
}
