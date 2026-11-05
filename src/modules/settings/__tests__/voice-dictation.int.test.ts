import { describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/auth/permissions";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { getSettingsData, setVoiceDictation, type Actor } from "../service";

describe("Ask AI dictation setting (Q-11)", () => {
  it("is off by default, with no settings row at all", async () => {
    const { actor } = await createTestAdmin("VoiceDefault");
    expect((await getSettingsData(actor.workspaceId)).ask.voiceDictation).toBe(false);
  });

  it("an Admin turns it on and off; each change is audited; other settings are kept", async () => {
    const { actor } = await createTestAdmin("VoiceOn");
    await setVoiceDictation(actor, true);
    const on = await getSettingsData(actor.workspaceId);
    expect(on.ask.voiceDictation).toBe(true);
    expect(on.outbound.autoSendEnabled).toBe(false);
    await setVoiceDictation(actor, false);
    expect((await getSettingsData(actor.workspaceId)).ask.voiceDictation).toBe(false);
    const rows = await scopedDb(actor).auditLog.findMany({
      where: { action: "settings.voice_dictation_changed" },
      orderBy: { createdAt: "asc" },
    });
    expect(rows.map((r) => (r.after as { voiceDictation: boolean }).voiceDictation)).toEqual([
      true,
      false,
    ]);
  });

  it("a non-admin is refused and nothing changes", async () => {
    const { actor } = await createTestAdmin("VoiceNo");
    for (const role of ["CS_LEADER", "CSM", "VIEWER"] as Actor["role"][]) {
      await expect(setVoiceDictation({ ...actor, role }, true)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    }
    expect((await getSettingsData(actor.workspaceId)).ask.voiceDictation).toBe(false);
  });
});
