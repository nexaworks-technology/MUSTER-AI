import type { Metadata } from "next";
import { requireSettingsAccess } from "../access";
import { AiTermsSection } from "./ai-terms-section";
import { DeleteSection } from "./delete-section";
import { ExportSection } from "./export-section";

export const metadata: Metadata = { title: "Data" };

/** Settings › Data (Admin only): export everything, what the AI provider does with the data (Q-19), or delete the
 * workspace (M12 B1, B2, B9). */
export default async function DataSettingsPage() {
  const ctx = await requireSettingsAccess("data:exportDelete");
  return (
    <div className="space-y-section max-w-3xl">
      <ExportSection actor={ctx} />
      <AiTermsSection />
      <DeleteSection actor={ctx} />
    </div>
  );
}
