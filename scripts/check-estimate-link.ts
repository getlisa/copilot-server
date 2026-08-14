/**
 * Regression check for the web-search fallback's link handling.
 *
 * The fallback prices a line from a live homedepot.com search when the catalog API cannot
 * answer. It cannot verify the URL it is handed: Home Depot returns 403 to every request from
 * our servers, including URLs known to be good (measured 2026-08-14 on four URLs, one of them a
 * product page we already hold verified). So shape is the only check available, and these are
 * the shapes actually observed coming back from search.
 *
 * A rejected URL is not a failure — it becomes a Home Depot search link, which always resolves.
 * What must never happen is a category page or a slug-less id being presented as the product
 * behind a price on a customer's quote.
 *
 * Pure — no network, no database.
 *   npx tsx scripts/check-estimate-link.ts
 */
import { homeDepotSearchLink, isProductUrl } from "../src/copilot/estimating/modelPriceEstimate";

/** [url, accepted as a product page] */
const CASES: [unknown, boolean][] = [
  // Real product pages, the form SerpApi and the storefront both use.
  ["https://www.homedepot.com/p/Halex-1-2-in-Electrical-Metallic-Tube-EMT-Set-Screw-Connectors-5-Pack-26270/100137321", true],
  ["https://www.homedepot.com/p/GE-100-Amp-12-Space-Load-Center-TM1210CCUBK1/304736474", true],
  ["https://www.homedepot.com/p/Southwire-250-ft-12-2-Romex-SIMpull-28828228/202019375?store=1234", true],

  // Both of these came back from the first two live probes and neither is a product page.
  ["https://www.homedepot.com/p/100204006", false], // id, no slug — 403s, and the id was wrong
  ["https://www.homedepot.com/b/Lighting-Light-Bulbs/A19/LED/N-5yc1vZbmbuZ1z0vvrdZ1z0vxij", false], // category

  // Other near-misses worth pinning.
  ["https://www.homedepot.com/s/A19%20LED%20bulb", false], // a search, not a product
  ["https://homedepot.com/p/Something/100137321", false], // no www — not the canonical host
  ["http://www.homedepot.com/p/Something/100137321", false], // plaintext
  ["https://www.homedepot.com.evil.example/p/Something/100137321", false], // lookalike host
  ["https://apionline.homedepot.com/p/Something/100137321", false], // internal host, not customer-facing
  ["https://www.lowes.com/pd/Something/100137321", false], // right shape, wrong retailer
  ["https://www.homedepot.com/p/Something/12345", false], // id too short to be a real SKU
  ["javascript:alert(1)", false],
  ["", false],
  [null, false],
  [undefined, false],
  [12345, false],
];

let pass = 0;
for (const [url, expected] of CASES) {
  const got = isProductUrl(url);
  const ok = got === expected;
  if (ok) pass++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  product=${String(got).padEnd(5)} expected=${String(expected).padEnd(5)} ${String(url).slice(0, 72)}`
  );
}

// The fallback link we build ourselves. It must be a homedepot.com search with the term encoded,
// because a raw space or "&" in a term would otherwise produce a broken or truncated URL.
const LINK_CASES: [string, string][] = [
  ["A19 LED bulb", "https://www.homedepot.com/s/A19%20LED%20bulb"],
  ["1/2 in EMT connector", "https://www.homedepot.com/s/1%2F2%20in%20EMT%20connector"],
  ["  12/2 NM-B cable  ", "https://www.homedepot.com/s/12%2F2%20NM-B%20cable"],
  ["wire nuts & connectors", "https://www.homedepot.com/s/wire%20nuts%20%26%20connectors"],
];
for (const [term, expected] of LINK_CASES) {
  const got = homeDepotSearchLink(term);
  const ok = got === expected;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  search link for "${term.trim()}" -> ${got}`);
}

const TOTAL = CASES.length + LINK_CASES.length;
console.log(`\n──── ${pass}/${TOTAL} passed`);
process.exit(pass === TOTAL ? 0 : 1);
