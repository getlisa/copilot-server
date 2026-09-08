import assert from "assert";
import { autoItemName } from "../src/lib/qbo";
import { itemKey, customerDisplayName } from "../src/lib/qboIngest";

/**
 * Pins the item-identity contract behind "sync an item once, then reuse its id".
 *
 * Only the pure half is testable here: the registry lookups and the create path need a database,
 * and this suite has no DB and no mocking. What that leaves is still the part that decides
 * whether duplicates happen — the key two different lines collapse onto. Get the casefolding
 * wrong and every estimate creates another "12 AWG Wire" in the customer's books.
 *
 * The resolution ORDER (link by pricebook row → link by name → mirror → live query → create) is
 * covered by the sandbox walkthrough in docs/qbo/QBO-INTEGRATION.md, not here. Said out loud so
 * nobody reads a green tick as proof the registry works.
 */

const line = (over: Partial<Parameters<typeof autoItemName>[0]> = {}) => ({
  isLabor: false,
  description: "12 AWG THHN wire, 500ft spool",
  searchTerm: "12 AWG THHN wire",
  ...over,
});

// ---- the name QuickBooks gets ----
assert.strictEqual(
  autoItemName(line()),
  "12 AWG THHN wire",
  "a catalog-shaped search term beats the prose description"
);
assert.strictEqual(autoItemName(line({ searchTerm: null })), "12 AWG THHN wire, 500ft spool");
assert.strictEqual(autoItemName(line({ isLabor: true })), "Labor", "labor collapses to one item");

// ---- the registry key ----
// Case and surrounding whitespace must NOT produce a second QBO item. This is the whole reason
// the key is casefolded before it is stored or looked up.
const variants = ["12 AWG THHN wire", "12 awg thhn WIRE", "  12 AWG THHN wire  "];
const keys = new Set(variants.map(itemKey));
assert.strictEqual(keys.size, 1, `case/space variants must share one key, got ${[...keys]}`);
assert.strictEqual(itemKey("12 AWG THHN wire"), "12 awg thhn wire");

// Distinct items must NOT collide.
assert.notStrictEqual(itemKey("Labor"), itemKey("Labour"));
assert.notStrictEqual(itemKey("20A breaker"), itemKey("30A breaker"));

// QBO caps Name at 100 characters, so the key is capped the same way — otherwise two long names
// that differ only past character 100 would be sent as one item and rejected as a duplicate.
const long = "x".repeat(140);
assert.strictEqual(itemKey(long).length, 100, "key is capped at QBO's Name limit");
assert.strictEqual(
  itemKey(autoItemName(line({ searchTerm: null, description: long }))).length,
  100,
  "the name QBO receives and the key we store are capped consistently"
);

// Labor is the one item every labor line shares, whatever the description says.
assert.strictEqual(
  itemKey(autoItemName(line({ isLabor: true, description: "Panel swap labour, 10 hrs" }))),
  "labor"
);

// ---- customer display names (Intuit's rules, ~/clara/customerqbo.md) ----
// A colon is QuickBooks' sub-customer separator, and tabs/newlines are rejected outright — so a
// name carrying any of them must be normalised here rather than failing at the API with a
// message nobody can act on.
assert.strictEqual(customerDisplayName("Acme: West"), "Acme West", "colon is the sub-customer separator");
assert.strictEqual(customerDisplayName("Acme\tWest"), "Acme West", "tabs are rejected by QBO");
assert.strictEqual(customerDisplayName("Acme\nWest"), "Acme West", "newlines are rejected by QBO");
assert.strictEqual(customerDisplayName("  Acme   West  "), "Acme West", "runs of space collapse");
assert.strictEqual(customerDisplayName(""), "", "empty stays empty so the caller can refuse it");
assert.strictEqual(customerDisplayName("x".repeat(160)).length, 100, "capped at QBO's limit");

console.log("check-qbo-items: OK");
