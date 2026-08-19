// One-off dev migration, applied through DATABASE_URL (the app's connection) on purpose:
// prisma migrate/db push read DIRECT_URL, which the duplicated .env entry points at PROD.
// For prod, run these same ALTERs via the migration runbook in docs/.
//
// Both columns are additive with defaults, so this is safe to run against a live database and
// safe to run twice. It MUST be applied BEFORE the code that reads these columns deploys —
// Prisma selects them on every quote query, so deploying first breaks the whole quotes API.
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
