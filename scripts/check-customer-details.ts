/**
 * Regression check for per-quote customer details (PRD US1–US3).
 *
 * The boundary this exists to hold: the three fields are fully optional passthroughs — they
 * never validate, never gate completion (no flag, no blocking count change), and render
 * blank/omitted when unset. Pure — no network, no database.
 *   npx tsx scripts/check-customer-details.ts
 */
import { toQuoteDto } from "../src/copilot/estimating/quoteDto";
import { buildQuoteDocx } from "../src/copilot/estimating/quoteDocx";

const now = new Date();

const quote = (customer: {
  customerName?: string | null;
  customerAddress?: string | null;
  customerPhone?: string | null;
}) =>
  ({
    id: "q1",
    conversationId: "c1",
    userId: 1n,
    companyId: 1,
    status: "DRAFT",
    markupPercent: 0,
    customerName: customer.customerName ?? null,
    customerAddress: customer.customerAddress ?? null,
    customerPhone: customer.customerPhone ?? null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    lineItems: [
      {
        id: "i1",
        quoteId: "q1",
        description: "12/2 Romex NM-B wire",
        quantity: 250,
        unit: "ft",
        unitPrice: 0.68,
        totalPrice: null,
        pricebookCode: "PB-1",
        searchTerm: "12/2 Romex wire",
        optionGroup: null,
        isLabor: false,
        agentSuggested: false,
        manuallyEdited: false,
        ambiguousAction: null,
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
      },
    ],
  }) as any;

let checks = 0;
function eq(actual: unknown, expected: unknown, label: string) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`FAIL: ${label}\n  expected ${e}\n  actual   ${a}`);
    process.exit(1);
  }
}

async function main() {
  // Passthrough: set fields come through verbatim, unset come through null.
  const full = toQuoteDto(quote({
    customerName: "John Miller",
    customerAddress: "42 Oak St, Springfield, IL",
    customerPhone: "(555) 014-2231",
  }));
  eq(full.customerName, "John Miller", "customerName passes through");
  eq(full.customerAddress, "42 Oak St, Springfield, IL", "customerAddress passes through");
  eq(full.customerPhone, "(555) 014-2231", "customerPhone passes through");

  const empty = toQuoteDto(quote({}));
  eq(empty.customerName, null, "unset customerName is null");
  eq(empty.customerAddress, null, "unset customerAddress is null");
  eq(empty.customerPhone, null, "unset customerPhone is null");

  const partial = toQuoteDto(quote({ customerPhone: "555-0142" }));
  eq(partial.customerName, null, "partial: name stays null");
  eq(partial.customerPhone, "555-0142", "partial: phone set alone");

  // No gating: customer fields never create a flag or change the blocking count (US3).
  eq(empty.blockingFlagCount, full.blockingFlagCount, "customer fields never block completion");

  // Documents build in every fill state; blank renders as omission, never as an error.
  for (const [label, dto] of [
    ["all fields", full],
    ["no fields", empty],
    ["one field", partial],
  ] as const) {
    const buffer = await buildQuoteDocx(dto);
    checks++;
    if (!(buffer.length > 0)) {
      console.error(`FAIL: quoteDocx builds with ${label}`);
      process.exit(1);
    }
  }

  console.log(`check-customer-details: ${checks} checks passed`);
}

main();
