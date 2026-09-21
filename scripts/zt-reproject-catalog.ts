/**
 * Re-project the stored ZenTrades raw catalog into pricebook_items, with no ZenTrades API call.
 * The raw store is the source of truth for the catalog, so a field-mapping fix lands on rows
 * that were ingested before it — which is the point of raw-first ingest.
 *
 *   npx tsx scripts/zt-reproject-catalog.ts            # every company with raw catalog rows
 *   npx tsx scripts/zt-reproject-catalog.ts 11         # one company
 */
import "dotenv/config";
import prisma from "../src/lib/prisma";
import { mapCatalogRow, projectCatalog } from "../src/lib/ztIngest";

async function main() {
  const arg = process.argv[2];
  const companyIds = arg
    ? [Number(arg)]
    : (await prisma.ztCatalogRaw.groupBy({ by: ["companyId"] })).map((g) => g.companyId);

  for (const companyId of companyIds) {
    const raws = await prisma.ztCatalogRaw.findMany({ where: { companyId } });
    const unmappable = raws.filter(
      (r) => mapCatalogRow(r.rawPayload as Record<string, unknown>, r.ztItemId) == null
    );
    const projected = await projectCatalog(companyId);
    console.log(
      `company ${companyId}: ${raws.length} raw rows → ${projected} priced, ${unmappable.length} skipped (no price or no description)`
    );
    for (const r of unmappable.slice(0, 10)) {
      const row = r.rawPayload as Record<string, unknown>;
      console.log(`  skipped ${r.kind} ${r.ztItemId}: code=${JSON.stringify(row.code)} sellPrice=${JSON.stringify(row.sellPrice)}`);
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
