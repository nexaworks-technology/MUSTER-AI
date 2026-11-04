import { inWorkspace } from "./m4";
import { seedPlaysForWorkspace } from "../../src/modules/plays/seeded/seed";

export async function prepareM8(workspaceSlug: string): Promise<string> {
  const seeded = await inWorkspace(workspaceSlug, async (tx, workspaceId) => {
    return await seedPlaysForWorkspace(workspaceId, tx);
  });
  return `M8 prepared: ${seeded} plays seeded`;
}
