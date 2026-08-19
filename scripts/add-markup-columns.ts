// One-off migration. Both columns are additive with defaults, so this is safe to run against a
// live database and safe to run twice. It MUST be applied BEFORE the code that reads these
// columns deploys — Prisma selects them on every quote query, so deploying first breaks the
// whole quotes API.
//
// THIS CANNOT RUN AS THE APPLICATION USER. Measured against techcopilot prod on 2026-08-19:
//
//   - quotes, quote_line_items, companies, conversations and pricebook_items are ALL owned by
//     `postgres`.
//   - DATABASE_URL and DIRECT_URL both connect as `app_user` (same user, both port 5432 — the
//     two URLs are not the privilege split they look like).
//   - `app_user` is not a member of `postgres`, so SET ROLE is not a way around it.
//   - The ALTER therefore fails with `42501: must be owner of table quotes`.
//
// This is the same wall documented in quoteDto.ts, which is why a web-search price is carried
// as an "EST" sentinel inside pricebookCode instead of getting its own column. Note that
// companies.proposal_email_template DOES exist in prod despite the sibling script implying
// app_user added it — that column is owned by `postgres` too, so it was applied out-of-band
// with a credential this repo does not hold.
//
// Run it as the Aurora master user (`postgres`), whose credential is the RDS-managed secret
// arn:aws:secretsmanager:us-east-1:458799594709:secret:rds!cluster-354ddf05-2500-40c0-a536-ab171d0ac675
// — readable by neither techcopilot-prod-ecs-execution-role (scoped to techcopilot/prod/*) nor
// the task role (S3 only). The database is Aurora on a private subnet, so this has to execute
// inside the VPC: a one-off `aws ecs run-task` against techcopilot-prod-assistant with
// DATABASE_URL overridden to the master credential is the shortest path.
//
// No existing quote's prices change. markup_percent defaults to 0, and at 0 the pricing path
// returns exactly what it returned before (pinned by scripts/check-markup.ts, which asserts
// markedUpPrices at 0% equals effectiveTotal for every line shape). The check at the end of
// this script proves the 0 rather than trusting it.
import prisma from "../src/lib/prisma";

async function main() {
  await prisma.$executeRawUnsafe(
    `ALTER TABLE quotes ADD COLUMN IF NOT EXISTS markup_percent NUMERIC(5,2) NOT NULL DEFAULT 0`
  );
  console.log("quotes.markup_percent: OK");

  await prisma.$executeRawUnsafe(
    `ALTER TABLE quote_line_items ADD COLUMN IF NOT EXISTS is_labor BOOLEAN NOT NULL DEFAULT FALSE`
  );
  console.log("quote_line_items.is_labor: OK");

  // Existing rows all default to is_labor = false, i.e. "material", so labor lines already on
  // an open Draft would be marked up once someone sets a markup. This backfills the shape that
  // is USUALLY labor: the agent emits a null search_term precisely when a line has nothing to
  // buy (see estimatingAgent priceFields) and pairs it with a technician-stated rate, which is
  // how every labor line it has ever created looks.
  //
  // It is a heuristic, not a proof, and it has a known false positive: a line hand-added
  // through addItem with a typed price has no search_term and no pricebook_code either, so a
  // hand-priced MATERIAL matches this too and is flipped to labor. That errs toward
  // undercharging, which is the direction that hides. Every flipped line is printed below for
  // exactly that reason — check the list, and fix any material in it with the Material/Labor
  // chip on the Invoice tab.
  const WHERE = `is_labor = FALSE
        AND search_term IS NULL
        AND unit_price IS NOT NULL
        AND pricebook_code IS NULL`;

  const toFlip = await prisma.$queryRawUnsafe<{ description: string; unit_price: string }[]>(
    `SELECT description, unit_price FROM quote_line_items WHERE ${WHERE} ORDER BY description`
  );
  const flipped = await prisma.$executeRawUnsafe(
    `UPDATE quote_line_items SET is_labor = TRUE WHERE ${WHERE}`
  );
  console.log(`\nquote_line_items reclassified as labor: ${flipped}`);
  for (const row of toFlip) {
    console.log(`  · ${row.description} — $${row.unit_price}`);
  }
  console.log(
    "  ^ any MATERIAL in that list is a false positive: fix it with the Material/Labor chip."
  );

  // Prices are only unchanged as long as every existing quote sits at 0% markup, which the
  // column default guarantees. Assert it instead of assuming it — a non-zero row here would
  // mean this script had already run and someone had since set a markup, and re-running the
  // backfill on that quote WOULD move its prices.
  const [{ quotes, withMarkup }] = await prisma.$queryRawUnsafe<
    { quotes: bigint; withMarkup: bigint }[]
  >(
    `SELECT COUNT(*) AS "quotes", COUNT(*) FILTER (WHERE markup_percent <> 0) AS "withMarkup"
       FROM quotes`
  );
  console.log(`\nquotes: ${quotes}, of those with a non-zero markup: ${withMarkup}`);
  console.log(
    withMarkup === 0n
      ? "No quote carries a markup yet, so no existing price changes. Safe to deploy."
      : "WARNING: a quote already carries a markup — the reclassification above moved its prices."
  );

  await prisma.$disconnect();
}

main();
