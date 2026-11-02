import { rawDb } from "@/lib/db/raw";

/**
 * Counts SQL statements Prisma sends while `fn` runs (test env emits query events). Transaction
 * control statements are excluded so the count reflects real reads/writes.
 */
type QueryEvent = { query: string };
const client = rawDb as unknown as { $on(event: "query", cb: (e: QueryEvent) => void): void };
let current: string[] | null = null;
client.$on("query", (e) => {
  if (current && !/^(BEGIN|COMMIT|ROLLBACK|SET|SELECT set_config)/i.test(e.query.trim()))
    current.push(e.query);
});

export async function countQueries<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; queries: number; statements: string[] }> {
  current = [];
  try {
    const result = await fn();
    return { result, queries: current.length, statements: current };
  } finally {
    current = null;
  }
}
