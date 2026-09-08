import assert from "assert";
import { autoItemName } from "../src/lib/qbo";
import { itemKey, customerDisplayName, taxGroupEffectiveRate } from "../src/lib/qboIngest";

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

// ---- a tax code's effective rate is the CASCADE of its group, not any one member ----
// Real sandbox data (company 9): the code "Tucson" is a group of AZ State tax 7.1% and Tucson
// City 2%. Matching a code to a rate of the same name would have charged 2% instead of 9.1% —
// a 7.1-point understatement, in customer money, with nothing to reveal it.
{
  const rates = new Map([["1", 7.1], ["2", 2], ["3", 8]]);
  const on = (value: string, order = 0) => ({
    TaxRateRef: { value },
    TaxTypeApplicable: "TaxOnAmount",
    TaxOrder: order,
  });

  assert.strictEqual(
    taxGroupEffectiveRate([on("1"), on("2")], rates),
    9.1,
    "Tucson = AZ State 7.1 + Tucson City 2"
  );
  assert.strictEqual(taxGroupEffectiveRate([on("3")], rates), 8, "California = 8");
  assert.strictEqual(taxGroupEffectiveRate([], rates), 0, "an empty group charges nothing");

  // A member referring to a rate we do not have is skipped, not treated as zero-and-counted:
  // silently charging less is worse than charging the part we can prove.
  assert.strictEqual(taxGroupEffectiveRate([on("1"), on("999")], rates), 7.1);

  // Compounding: 10% then 5% applied on net-plus-tax is 15.5%, not 15%. Every sandbox rate is
  // TaxOnAmount so this path is unexercised there — which is exactly why it needs a test.
  const compound = new Map([["a", 10], ["b", 5]]);
  assert.strictEqual(
    taxGroupEffectiveRate(
      [
        { TaxRateRef: { value: "a" }, TaxTypeApplicable: "TaxOnAmount", TaxOrder: 0 },
        { TaxRateRef: { value: "b" }, TaxTypeApplicable: "TaxOnAmountPlusTax", TaxOrder: 1 },
      ],
      compound
    ),
    15.5,
    "TaxOnAmountPlusTax compounds on net + tax so far"
  );

  // TaxOrder decides the cascade, so an out-of-order list must not change the answer.
  assert.strictEqual(
    taxGroupEffectiveRate(
      [
        { TaxRateRef: { value: "b" }, TaxTypeApplicable: "TaxOnAmountPlusTax", TaxOrder: 1 },
        { TaxRateRef: { value: "a" }, TaxTypeApplicable: "TaxOnAmount", TaxOrder: 0 },
      ],
      compound
    ),
    15.5,
    "members are cascaded in TaxOrder, whatever order they arrive in"
  );
}

console.log("check-qbo-items: OK");
