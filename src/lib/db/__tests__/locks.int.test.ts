import { describe, expect, it } from "vitest";
import { withDatabaseLock } from "../locks";

/** A database-wide mutex (D-68): two holders of the same lock never overlap, even across processes. */
describe("withDatabaseLock", () => {
  it("runs holders of the same lock one after the other and returns their results", async () => {
    const log: string[] = [];
    const work = (name: string) =>
      withDatabaseLock("locks-test", async () => {
        log.push(`${name}:start`);
        await new Promise((r) => setTimeout(r, 150));
        log.push(`${name}:end`);
        return name;
      });
    expect(await Promise.all([work("a"), work("b")])).toEqual(["a", "b"]);
    // Without the lock this would be a:start, b:start, a:end, b:end.
    expect([
      ["a:start", "a:end", "b:start", "b:end"],
      ["b:start", "b:end", "a:start", "a:end"],
    ]).toContainEqual(log);
  });

  it("releases the lock when the work throws", async () => {
    await expect(
      withDatabaseLock("locks-test-2", () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
    expect(await withDatabaseLock("locks-test-2", async () => "again")).toBe("again");
  });
});
