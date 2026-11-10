import type { Metadata } from "next";
import { MeetingsIndexView } from "@/components/app/meetings-index";
import { listMeetingsIndex } from "@/modules/meetings/service";
import { loadAccount } from "../data";

export const metadata: Metadata = { title: "Meetings & QBRs" };

export default async function AccountMeetingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx, account } = await loadAccount(id);
  const index = await listMeetingsIndex(ctx, { accountId: account.id });
  return <MeetingsIndexView index={index} tz={ctx.workspace.timezone} showAccount={false} />;
}
