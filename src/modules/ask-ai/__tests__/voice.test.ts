import { describe, expect, it } from "vitest";
import { browserHasSpeechRecognition, dictationOffered } from "../schemas";

describe("dictation button decision (Q-11)", () => {
  it("is offered only when the workspace turned it on and the browser supports it", () => {
    expect(dictationOffered({ workspaceEnabled: true, browserSupported: true })).toBe(true);
    expect(dictationOffered({ workspaceEnabled: true, browserSupported: false })).toBe(false);
    expect(dictationOffered({ workspaceEnabled: false, browserSupported: true })).toBe(false);
    expect(dictationOffered({ workspaceEnabled: false, browserSupported: false })).toBe(false);
  });
  it("detects the standard and the prefixed browser API", () => {
    expect(browserHasSpeechRecognition({})).toBe(false);
    expect(browserHasSpeechRecognition({ SpeechRecognition: class {} })).toBe(true);
    expect(browserHasSpeechRecognition({ webkitSpeechRecognition: class {} })).toBe(true);
  });
});
