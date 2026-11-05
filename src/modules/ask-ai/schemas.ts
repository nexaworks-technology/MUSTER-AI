/**
 * Q-11: the dictation button appears only when the Admin turned it on AND the browser exposes its
 * own speech recognition. It only fills the text box; nothing server-side processes audio.
 */
export function dictationOffered(input: { workspaceEnabled: boolean; browserSupported: boolean }) {
  return input.workspaceEnabled && input.browserSupported;
}

/** Client-side capability check (the vendor-prefixed constructor included). */
export function browserHasSpeechRecognition(w: object): boolean {
  return "SpeechRecognition" in w || "webkitSpeechRecognition" in w;
}
