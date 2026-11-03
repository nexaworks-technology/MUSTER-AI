import { handleUsageRequest } from "@/modules/integrations/service";

/** POST /api/usage/v1/identify — the Usage API (M6 B1). Key- or Segment-signature-authenticated; no session. */
export const POST = (req: Request) => handleUsageRequest(req, "identify");
