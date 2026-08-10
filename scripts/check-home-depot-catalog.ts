/**
 * Functional check for the Home Depot catalog resolver.
 *
 * Imports the REAL modules from src/, so it exercises the shipped code path. The prisma
 * upsert inside resolveFromHomeDepot is wrapped in try/catch, so this runs end-to-end
 * WITHOUT a database — everything except persistence is genuinely exercised.
 *
 * Costs real SerpApi searches (5 per case) and one OpenAI call per case that reaches
 * selection. Companion to scripts/check-pricebook-match.ts.
 *
 *   SERP_API_KEY_1=… OPENAI_API_KEY=… npx tsx scripts/check-home-depot-catalog.ts
 */
import { resolveFromHomeDepot, isCatalogEnabled } from "../src/copilot/estimating/homeDepotCatalog";
import { keysConfigured, keysAvailable } from "../src/lib/serpapi";
import { matchPricebook } from "../src/copilot/estimating/pricebookMatch";

const CASES: { description: string; expect: "resolve" | "null"; why: string }[] = [
  { description: "GFCI receptacle", expect: "resolve", why: "HD stocks these" },
  { description: "200 amp load center", expect: "resolve", why: "HD stocks these" },
  { description: "3/4 in EMT conduit", expect: "resolve", why: "HD stocks these" },
  {
    description: "fire sprinkler head pendant 155 degree",
    expect: "null",
    why: "HD does NOT stock commercial fire-protection heads — the absence detector should fire",
  },
  { description: "flux capacitor 1.21 gigawatt", expect: "null", why: "nonsense — nothing should clear the gates" },
];

async function main() {
  console.log(
    `catalog enabled: ${isCatalogEnabled()} | keys configured: ${keysConfigured()} | available: ${keysAvailable()}`
  );

  // Pure sanity check on the matcher the resolver sits behind (no network).
  const book = [
    {
      id: 1,
      code: "EL-001",
      description: "GFCI receptacle 20A",
      unit: "EA",
      unitPrice: 24.5,
      synonyms: ["gfci", "ground fault outlet"],
    },
  ];
  const hit = matchPricebook("gfci outlet", book)?.code ?? "null";
  const miss = matchPricebook("roof flashing", book)?.code ?? "null";
  console.log(`matchPricebook: "gfci outlet" -> ${hit} (expect EL-001) | "roof flashing" -> ${miss} (expect null)\n`);

  let pass = 0;
  for (const c of CASES) {
    const t0 = Date.now();
    let got: Awaited<ReturnType<typeof resolveFromHomeDepot>> = null;
    let err: string | null = null;
    try {
      got = await resolveFromHomeDepot(c.description, 1);
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const outcome = err ? "ERROR" : got ? "resolve" : "null";
    const ok = !err && outcome === c.expect;
    if (ok) pass++;

    console.log(`${ok ? "PASS" : "FAIL"}  "${c.description}"  (${secs}s)`);
    console.log(`      expected=${c.expect}  got=${outcome}  — ${c.why}`);
    if (err) console.log(`      error: ${err}`);
    if (got) {
      console.log(`      ${got.code}  $${got.unitPrice}/${got.unit}  brand=${got.brand ?? "-"}  pack=${got.packageQuantity ?? "-"}  rating=${got.rating ?? "-"}`);
      console.log(`      ${got.externalLink ?? "(no link)"}`);
    }
    console.log("");
  }

  console.log(`──── ${pass}/${CASES.length} passed`);
  process.exit(pass === CASES.length ? 0 : 1);
}

main().catch((e) => {
  console.error("harness failed:", e);
  process.exit(1);
});
