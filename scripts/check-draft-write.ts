/**
 * Regression check for the Draft-write guard's WHERE clause (draftWrite.ts).
 *
 * The race fix rests on one property: the guard's own `id` and `quote` conditions must always
 * survive, whatever a caller passes as `extraWhere`. If that spread order were ever inverted, a
 * caller could widen the clause instead of narrowing it and every write in the module would
 * silently lose its tenant and status scoping — with nothing failing, because the writes would
 * still succeed. This pins the order so that regression cannot land quietly.
 *
 * Pure — no network, no database.
 *   npx tsx scripts/check-draft-write.ts
 */
import { draftLineItemWhere } from "../src/copilot/estimating/draftWrite";

let failures = 0;

/**
 * Compare by VALUE, not by key order. A spread that overrides a key keeps that key's original
 * insertion position while taking the later value, so `{...{quote: theirs}, quote: ours}` is
 * `{quote: ours}` sitting in first position — correct, but not the same string as a literal
 * written guard-first. Plain JSON.stringify equality fails that, which would make this check
 * assert the guard's key ORDER rather than the scoping it actually enforces.
 */
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : val
  );

const expect = (label: string, actual: unknown, expected: unknown) => {
  const ok = canonical(actual) === canonical(expected);
  if (!ok) {
    failures++;
    console.error(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  } else console.log(`ok   ${label}`);
};

// The base clause: always the line id AND the parent quote's company AND Draft status.
expect("base clause scopes to the line, the company and DRAFT", draftLineItemWhere("line-1", 7), {
  id: "line-1",
  quote: { companyId: 7, status: "DRAFT" },
});

// The automatic paths add manuallyEdited; it must merge in, not displace the guard.
expect(
  "extraWhere merges alongside the guard",
  draftLineItemWhere("line-1", 7, { manuallyEdited: false }),
  { manuallyEdited: false, id: "line-1", quote: { companyId: 7, status: "DRAFT" } }
);

// The load-bearing case. A caller passing `id` or `quote` must NOT be able to override the
// guard — these are the exact keys an attacker-shaped or simply careless caller would supply.
expect(
  "a caller cannot override the line id",
  draftLineItemWhere("line-1", 7, { id: "someone-elses-line" }),
  { id: "line-1", quote: { companyId: 7, status: "DRAFT" } }
);
expect(
  "a caller cannot override the company or reach a COMPLETED quote",
  draftLineItemWhere("line-1", 7, { quote: { companyId: 999, status: "COMPLETED" } }),
  { id: "line-1", quote: { companyId: 7, status: "DRAFT" } }
);

// An empty extraWhere is the same as none — the default parameter must not leak a key.
expect("an explicit empty extraWhere matches the default", draftLineItemWhere("line-1", 7, {}), {
  id: "line-1",
  quote: { companyId: 7, status: "DRAFT" },
});

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll draft-write guard checks passed");
