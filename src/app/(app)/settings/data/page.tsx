import type { Metadata } from "next";
import { requireSettingsAccess } from "../access";
import { DeleteSection } from "./delete-section";
import { ExportSection } from "./export-section";

export const metadata: Metadata = { title: "Data" };

/** Settings › Data (Admin only): export everything, or delete the workspace (M12 B1, B2). */
export default async function DataSettingsPage() {
  const ctx = await requireSettingsAccess("data:exportDelete");
  return (
    <div className="max-w-3xl space-y-8">
      <ExportSection actor={ctx} />
      <DeleteSection actor={ctx} />
    </div>
  );
}
