// Deliberate violation: sending customer email outside outbound.dispatch (Rule 3).
import { customerTransport } from "@/lib/email/customerTransport";

export const send = customerTransport;
