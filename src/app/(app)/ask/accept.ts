import { ALLOWED_BY_PURPOSE } from "@/config/uploads";

/** The file picker's `accept` list, from the one upload rule set (the server checks it again). */
export const ASK_ACCEPT = ALLOWED_BY_PURPOSE.ASK_ATTACHMENT.map((e) => `.${e}`).join(",");
