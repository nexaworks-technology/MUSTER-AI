import type { Metadata } from "next";
import { requireSettingsAccess } from "../access";
import { ExportSection } from "./export-section";

export const metadata: Metadata = { title: "Data" };

/** Settings › Data (Admin only): export now; deletion joins this page in M12 B2. */
export default async function DataSettingsPage() {
  const ctx = await requireSettingsAccess("data:exportDelete");
  return (
    <div className="max-w-3xl space-y-8">
      <ExportSection actor={ctx} />
    </div>
  );
}
