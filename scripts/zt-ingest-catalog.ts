/**
 * Pull a company's ZenTrades price catalog (pricebook materials OR flat-rate items, whichever
 * the account is set to) and project it into pricebook_items — the catalog stage of the sync,
 * run on its own so jobs/deficiencies/tax are not touched.
 *
 *   npx tsx scripts/zt-ingest-catalog.ts <userId>          # preview: shows the target, writes nothing
 *   npx tsx scripts/zt-ingest-catalog.ts <userId> --yes    # actually ingest
 *
 * Writes to whatever DATABASE_URL points at — the preview prints the host so you can confirm
 * you are on the database you meant before passing --yes.
 *
 * Needs, in the environment:
 *   DATABASE_URL   the target database (Aurora is in a private VPC: reachable only through a
 *                  tunnel/bastion, not from a laptop directly)
 *   ZT_TOKEN_KEY   the SAME key that sealed zt_connections.encrypted_auth on that database,
 *                  or the stored ZenTrades credentials cannot be decrypted
 */
import "dotenv/config";
import prisma from "../src/lib/prisma";
import { ztConnectionFor, ztConnected, isZtConfigured } from "../src/lib/zt";
import { ingestCatalog } from "../src/lib/ztIngest";

const dbHost = () => {
  try {
    return new URL(process.env.DATABASE_URL ?? "").host;
  } catch {
    return "(DATABASE_URL unset or unparseable)";
  }
};

async function main() {
  const userId = process.argv[2];
  const confirmed = process.argv.includes("--yes");
  if (!userId) throw new Error("usage: npx tsx scripts/zt-ingest-catalog.ts <userId> [--yes]");

  const user = await prisma.users.findUnique({
    where: { id: BigInt(userId) },
    select: { id: true, email: true, company_id: true, companies: { select: { name: true } } },
  });
  if (!user) throw new Error(`no user with id ${userId} on ${dbHost()}`);
  const companyId = user.company_id;

  const conn = await ztConnectionFor(companyId);
  const before = await prisma.pricebookItem.count({ where: { companyId, source: "ZENTRADES" } });

  console.log(`database    ${dbHost()}`);
  console.log(`user        ${user.id} <${user.email}>`);
  console.log(`company     ${companyId} — ${user.companies?.name ?? "(unnamed)"}`);
  console.log(`connected   ${ztConnected(conn) ? `yes (ZenTrades company ${conn.ztCompanyName ?? conn.ztCompanyId})` : "NO"}`);
  console.log(`ZT_TOKEN_KEY ${isZtConfigured() ? "set" : "MISSING"}`);
  console.log(`existing    ${before} ZENTRADES pricebook items`);

  if (!ztConnected(conn)) {
    throw new Error(
      `ZenTrades is not connected for company ${companyId} — connect it in the Connections card first`
    );
  }
  if (!isZtConfigured()) {
    throw new Error("ZT_TOKEN_KEY is not set: the stored ZenTrades credentials cannot be decrypted");
  }
  if (!confirmed) {
    console.log("\npreview only — nothing written. Re-run with --yes to ingest.");
    return;
  }

  console.log("\ningesting…");
  const projected = await ingestCatalog(conn, companyId);
  const after = await prisma.pricebookItem.count({ where: { companyId, source: "ZENTRADES" } });
  const raw = await prisma.ztCatalogRaw.count({ where: { companyId } });
  const unprojected = await prisma.ztCatalogRaw.count({
    where: { companyId, projectedItemId: null },
  });
  console.log(
    `done: ${raw} raw catalog rows, ${projected} priced, ${unprojected} skipped (no sell price, ` +
      `inactive, or the code belongs to a company-authored item). ZENTRADES items ${before} → ${after}.`
  );
}

main()
  .catch((e) => {
    console.error(`\n${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
