/**
 * Runs docs/sql/zt-backfill-pricebook.sql against the CURRENT database inside a transaction
 * that is always rolled back, and prints what it would have written. Nothing is committed.
 *
 *   npx tsx scripts/check-zt-backfill-sql.ts 11
 */
import "dotenv/config";
import { readFileSync } from "fs";
import { join } from "path";
import prisma from "../src/lib/prisma";

const ROLLBACK = "intentional rollback";

async function main() {
  const cid = Number(process.argv[2] ?? 11);
  const sql = readFileSync(join(__dirname, "../docs/sql/zt-backfill-pricebook.sql"), "utf8");

  const statements = sql
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("\\")) // psql meta-commands
    .map((l) => l.replace(/--.*$/, "")) // comments first: one of them contains a ';'
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s && !/^(BEGIN|COMMIT)$/i.test(s))
    .map((s) => s.replace(/:cid\b/g, String(cid)));

  try {
    await prisma.$transaction(async (tx) => {
      for (const stmt of statements) {
        if (/^SELECT/i.test(stmt)) {
          console.log(stmt.split("\n")[0].slice(0, 60), "→", await tx.$queryRawUnsafe(stmt));
        } else {
          const n = await tx.$executeRawUnsafe(stmt);
          console.log(`${stmt.split("\n")[0].slice(0, 60)} → ${n} row(s)`);
        }
      }
      throw new Error(ROLLBACK);
    });
  } catch (e) {
    if (!(e instanceof Error) || e.message !== ROLLBACK) throw e;
    console.log("\nrolled back — nothing written");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
