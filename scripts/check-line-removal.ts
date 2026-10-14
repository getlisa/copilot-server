import assert from "assert";
import prisma from "../src/lib/prisma";

/**
 * Proves the line-removal statement against a real Postgres, because what matters here is
 * Postgres behaviour rather than TypeScript: the delete and the archive cannot come apart, a
 * retry archives nothing, and a completed quote refuses the removal.
 *
 * Everything runs inside ONE transaction in a throwaway schema and is then rolled back, so it
 * leaves nothing behind and never touches the real tables. Skips cleanly when no database is
 * reachable — which is how it behaves during the Docker build.
 *
 *   npx tsx scripts/check-line-removal.ts
 */

/** The statement under test, as src/copilot/estimating/lineItemRemoval.ts issues it. */
const REMOVE = `
  WITH locked AS (
    SELECT id FROM quotes WHERE id = $1 AND company_id = $2 AND status = 'DRAFT' FOR UPDATE
  ),
  removed AS (
    DELETE FROM quote_line_items
     WHERE id = ANY($3::text[]) AND quote_id IN (SELECT id FROM locked)
    RETURNING *
  )
  INSERT INTO quote_line_items_deleted
    (id, quote_id, agent_suggested, is_labor, quantity, unit_price, deleted_at, deleted_by, snapshot)
  SELECT r.id, r.quote_id, r.agent_suggested, r.is_labor, r.quantity, r.unit_price, now(), $4, to_jsonb(r)
    FROM removed r
  RETURNING id`;

class Rollback extends Error {}

async function main() {
  try {
    await prisma.$queryRawUnsafe("SELECT 1");
  } catch {
    console.log("skip check-line-removal: no database reachable");
    return;
  }

  try {
    await prisma.$transaction(async (tx) => {
      // A schema of its own, so these names cannot collide with the real tables.
      await tx.$executeRawUnsafe(`CREATE SCHEMA check_line_removal`);
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO check_line_removal`);
      await tx.$executeRawUnsafe(`
        CREATE TABLE quotes (id text primary key, company_id int, status text NOT NULL)`);
      await tx.$executeRawUnsafe(`
        CREATE TABLE quote_line_items (
          id text primary key, quote_id text NOT NULL, agent_suggested bool DEFAULT false,
          is_labor bool DEFAULT false, quantity numeric(12,2), unit_price numeric(12,2))`);
      await tx.$executeRawUnsafe(`
        CREATE TABLE quote_line_items_deleted (
          id text primary key, quote_id text NOT NULL, agent_suggested bool NOT NULL DEFAULT false,
          is_labor bool NOT NULL DEFAULT false, quantity numeric(12,2), unit_price numeric(12,2),
          deleted_at timestamp NOT NULL DEFAULT now(), deleted_by bigint, snapshot jsonb NOT NULL)`);
      await tx.$executeRawUnsafe(`
        INSERT INTO quotes VALUES ('D', 1, 'DRAFT'), ('C', 1, 'COMPLETED')`);
      // Ten agent-proposed lines on the draft, so the rate has a round denominator, plus one
      // the technician typed and one on the completed quote.
      await tx.$executeRawUnsafe(`
        INSERT INTO quote_line_items (id, quote_id, agent_suggested, quantity, unit_price)
          SELECT 'D'||g, 'D', true, 2, 100 FROM generate_series(1,10) g`);
      await tx.$executeRawUnsafe(`
        INSERT INTO quote_line_items (id, quote_id, agent_suggested) VALUES ('M1','D',false), ('C1','C',true)`);

      const remove = (quoteId: string, companyId: number, ids: string[]) =>
        tx.$queryRawUnsafe<{ id: string }[]>(REMOVE, quoteId, companyId, ids, BigInt(7));
      const count = async (sql: string) =>
        Number((await tx.$queryRawUnsafe<{ n: bigint }[]>(sql))[0].n);

      // ---- the line leaves the live table and lands in the archive -------------------------
      assert.strictEqual((await remove("D", 1, ["D1", "D2", "D3"])).length, 3, "three removed");
      assert.strictEqual(
        await count(`SELECT count(*) n FROM quote_line_items WHERE quote_id='D'`),
        8,
        "11 lines minus the 3 removed"
      );
      assert.strictEqual(await count(`SELECT count(*) n FROM quote_line_items_deleted`), 3);

      // The whole row is kept, not a tally — what a counter could never answer later.
      const snap = (
        await tx.$queryRawUnsafe<{ snapshot: Record<string, unknown> }[]>(
          `SELECT snapshot FROM quote_line_items_deleted WHERE id='D1'`
        )
      )[0].snapshot;
      assert.strictEqual(snap.quote_id, "D");
      assert.strictEqual(Number(snap.unit_price), 100);
      assert.strictEqual(
        await count(`SELECT count(*) n FROM quote_line_items_deleted WHERE deleted_by = 7`),
        3,
        "who removed it is recorded"
      );

      // ---- retrying the identical statement archives nothing -------------------------------
      // The INSERT is fed by the DELETE's RETURNING, so a retry after an ambiguous failure
      // finds the rows already gone and writes zero. A blind increment would double-count.
      assert.strictEqual((await remove("D", 1, ["D1", "D2", "D3"])).length, 0, "retry is a no-op");
      assert.strictEqual(
        await count(`SELECT count(*) n FROM quote_line_items_deleted`),
        3,
        "and archives nothing the second time"
      );

      // ---- a COMPLETED quote refuses the removal -------------------------------------------
      assert.strictEqual((await remove("C", 1, ["C1"])).length, 0, "completed quote refuses");
      assert.strictEqual(
        await count(`SELECT count(*) n FROM quote_line_items WHERE id='C1'`),
        1,
        "the line is still there"
      );

      // ---- another company cannot reach this company's lines -------------------------------
      assert.strictEqual((await remove("D", 999, ["D4"])).length, 0, "wrong company removes nothing");

      // ---- the rate reads 3 of 10, not 3 of 7 ----------------------------------------------
      // The denominator must add the removed lines back, or every deletion is counted twice:
      // once in the numerator, and once as a proposal that is no longer standing.
      const numerator = await count(
        `SELECT count(*) n FROM quote_line_items_deleted WHERE quote_id='D' AND agent_suggested`
      );
      const denominator =
        (await count(
          `SELECT count(*) n FROM quote_line_items WHERE quote_id='D' AND agent_suggested`
        )) + numerator;
      assert.strictEqual(numerator, 3);
      assert.strictEqual(denominator, 10, "7 survivors + 3 removed = what the agent proposed");
      assert.strictEqual(numerator / denominator, 0.3);
      // The technician's own line M1 is in neither figure: never the agent's to propose.

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  console.log("ok   check-line-removal: archive, retry safety, Draft re-check, 3 of 10");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
