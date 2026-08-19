// One-off dev migration, applied through DATABASE_URL (the app's connection) on purpose:
// prisma migrate/db push read DIRECT_URL, which the duplicated .env entry points at PROD.
// For prod, run these same ALTERs via the migration runbook in docs/.
//
// Both columns are additive with defaults, so this is safe to run against a live database and
// safe to run twice. It MUST be applied BEFORE the code that reads these columns deploys —
// Prisma selects them on every quote query, so deploying first breaks the whole quotes API.
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

  // Existing rows all default to is_labor = false, i.e. "material". Labor lines already on an
  // open Draft would therefore be marked up. Backfill the one shape that is unambiguously
  // labor today: the agent emits a null search_term precisely when a line has nothing to buy
  // (see estimatingAgent priceFields), and pairs it with a technician-stated price. A material
  // line always either carries a search_term or is still waiting to be priced.
  const backfilled = await prisma.$executeRawUnsafe(
    `UPDATE quote_line_items
        SET is_labor = TRUE
      WHERE is_labor = FALSE
        AND search_term IS NULL
        AND unit_price IS NOT NULL
        AND pricebook_code IS NULL`
  );
  console.log(`quote_line_items backfilled to is_labor = true: ${backfilled}`);

  await prisma.$disconnect();
}

main();
