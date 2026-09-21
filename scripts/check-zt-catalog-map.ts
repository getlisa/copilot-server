/**
 * Regression check for the ZenTrades catalog field mapping (mapCatalogRow). The payloads below
 * are real shapes taken from zt_catalog_raw — sellPrice, not price, is what both endpoints
 * send, and salesDescription arrives as " " when unset. Pure: no network, no database.
 *
 *   npx tsx scripts/check-zt-catalog-map.ts
 */
import { mapCatalogRow } from "../src/lib/ztIngest";

let failures = 0;
const expect = (label: string, actual: unknown, expected: unknown) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.error(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  } else console.log(`ok   ${label}`);
};

// Flat-rate item: description + sellPrice.
expect(
  "flat-rate item",
  mapCatalogRow(
    { id: "Ao3jIkwxBE", code: "Valve", description: '1/4" Valve', sellPrice: 25, costPrice: 0, isActive: true },
    "Ao3jIkwxBE"
  ),
  { code: "Valve", description: '1/4" Valve', unit: "EA", price: 25 }
);

// Pricebook material: no `description` at all, and salesDescription blank — the code carries
// the only usable text. `a ?? b` would have stopped on the blank string here.
expect(
  "pricebook material, blank salesDescription",
  mapCatalogRow(
    { id: 65, code: "M002", identifier: "M002", salesDescription: " ", purchaseDescription: "", sellPrice: 5660, costPrice: 500 },
    "65"
  ),
  { code: "M002", description: "M002", unit: "EA", price: 5660 }
);

// salesDescription wins when it actually says something.
expect(
  "pricebook material, real salesDescription",
  mapCatalogRow({ code: "Item 88", identifier: "Item 88", salesDescription: "Backflow kit", sellPrice: 12.5 }, "88"),
  { code: "Item 88", description: "Backflow kit", unit: "EA", price: 12.5 }
);

// Cost-only row: unpriced, so it must NOT be projected at cost.
expect("no sell price", mapCatalogRow({ code: "Test", sellPrice: null, costPrice: 500 }, "88713"), null);
expect("deleted row", mapCatalogRow({ code: "X", sellPrice: 10, isDeleted: true }, "9"), null);
expect("inactive row", mapCatalogRow({ code: "X", sellPrice: 10, isActive: false }, "9"), null);
// A free line is a price, not a missing one.
expect("zero price is priced", mapCatalogRow({ code: "Free", sellPrice: 0 }, "10"), {
  code: "Free",
  description: "Free",
  unit: "EA",
  price: 0,
});
// Nothing identifiable: the ZenTrades id keeps the row addressable.
expect("no code falls back to zt id", mapCatalogRow({ name: "Mystery part", sellPrice: 4 }, "abc"), {
  code: "ZT-abc",
  description: "Mystery part",
  unit: "EA",
  price: 4,
});

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
