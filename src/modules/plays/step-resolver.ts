import type { AccountTier, ApprovalLevel } from "@prisma/client";
import { resolveLevel } from "@/modules/approvals/level-resolver";
import type { PlayStepDefinition } from "./definition";

export interface ResolvePlayStepLevelInput {
  step: PlayStepDefinition;
  tier: AccountTier;
  workspaceCeiling: ApprovalLevel;
  autoSendEnabled: boolean;
  isSensitive?: boolean;
}

export function resolvePlayStepLevel(input: ResolvePlayStepLevelInput): ApprovalLevel {
  const isCustomerFacing = input.step.handler === "draft" || input.step.handler === "send";
  return resolveLevel({
    tier: input.tier,
    customerFacing: isCustomerFacing,
    workspaceCeiling: input.workspaceCeiling,
    isSensitive: Boolean(input.isSensitive || input.step.sensitive),
    autoSendEnabled: input.autoSendEnabled,
    stepLevel: input.step.approvalLevelByTier[input.tier],
    safeStep: input.step.safe,
  });
}
