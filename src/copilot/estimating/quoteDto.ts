import { homeDepotSearchLink } from "./modelPriceEstimate";
import { PricebookItem, Quote, QuoteLineItem } from "@prisma/client";

/**
 * Serialization + flag derivation for quotes. Flags are DERIVED from row state,
 * not stored, so they can never drift:
 *  - ambiguous:          row is a pending ambiguous reference (tap-to-select)
 *  - agent_suggested:    KB proposal the technician hasn't confirmed yet
 *  - missing_quantity:   quantity is null (the system never invents a number)
 *  - unmatched:          no pricebook match and no manual price
 *  - manually_edited:    price differs from pricebook (informational, non-blocking)
 */

export const BLOCKING_FLAGS = [
  "ambiguous",
  "agent_suggested",
  "missing_quantity",
  "unmatched",
  // A web-search price has no product id behind it, so it cannot be verified the way a catalog
  // price can. It blocks completion for the same reason an agent-suggested line does: a human
  // has to look at it before it reaches a customer.
  "estimated_price",
] as const;

export type LineItemFlag = (typeof BLOCKING_FLAGS)[number] | "manually_edited";

/**
 * Catalog provenance for a line priced from an external source (currently Home Depot).
 * Present only when the line's pricebookCode resolves to a row with source = HOME_DEPOT.
 *
 * The link is RENDERED by the client as an anchor — never regenerated from text — because a
 * model retyping a long product URL can silently corrupt the slug or id.
 */
export interface LineItemProduct {
  productId: string | null;
  /** Canonical www.homedepot.com URL. */
  link: string | null;
  brand: string | null;
  rating: number | null;
  /** Pack size behind unitPrice, so a 12-pack can't read as a unit price. */
  packageQuantity: number | null;
  /** True until a technician accepts the line this was resolved for. */
  provisional: boolean;
}

export interface LineItemDto {
  id: string;
  description: string;
  quantity: number | null;
  unit: string | null;
  unitPrice: number | null;
  totalPrice: number | null;
  pricebookCode: string | null;
  /** Null when the line is unpriced or priced from the company's own book. */
  product: LineItemProduct | null;
  /**
   * This price came from a live web search of homedepot.com rather than the catalog API, so no
   * product id stands behind it. Render it visibly differently from a `product` price: it is an
   * educated figure for the technician to confirm, and it blocks completion until they do.
   */
  priceEstimated: boolean;
  /** Product URL when the search returned a real-looking one, else a Home Depot search URL. */
  estimateLink: string | null;
  flags: LineItemFlag[];
  ambiguousAction: {
    action: "remove" | "update";
    candidateItemIds: string[];
    referenceText: string;
    fields?: { description?: string; quantity?: number; unit?: string };
  } | null;
  /** Alternative-option group ("Option A – …"); null = base scope. */
  optionGroup: string | null;
  sortOrder: number;
}

export interface QuoteOptionTotal {
  name: string;
  /** This option's lines alone. */
  total: number;
  /** Base scope + this option — the price if the customer picks it. */
  combinedTotal: number;
}

export interface QuoteDto {
  id: string;
  conversationId: string;
  status: "DRAFT" | "COMPLETED";
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  lineItems: LineItemDto[];
  /**
   * Base-scope lines only. Option-group lines are alternatives the customer picks between,
   * so they are NEVER part of this sum — see optionTotals. With no option groups this is
   * simply the sum of every line, as before.
   */
  total: number;
  /** Present (non-empty) only when the quote carries alternative option groups. */
  optionTotals: QuoteOptionTotal[];
  blockingFlagCount: number;
}

const num = (v: unknown): number | null => (v == null ? null : Number(v));

/**
 * Sentinel pricebook code for a line priced by web search instead of the catalog.
 *
 * It lives in `pricebookCode` rather than its own column because adding one requires ownership
 * of the table and the application connects as `app_user`, which Postgres will not let alter a
 * table owned by `postgres`. The sentinel is safe in that field: no pricebook row has this code,
 * so `catalogFor` finds nothing and `product` stays null — an estimate can never be dressed up
 * as catalog provenance. It is also what the resolver's backfill already overwrites, since that
 * update targets any code not prefixed `HD-`.
 */
export const ESTIMATED_PRICE_CODE = "EST";

/** True when this line's price came from a web search rather than the catalog. */
export function isEstimatedPrice(item: { pricebookCode: string | null }): boolean {
  return item.pricebookCode === ESTIMATED_PRICE_CODE;
}

export function flagsFor(item: QuoteLineItem): LineItemFlag[] {
  if (item.ambiguousAction) return ["ambiguous"];
  const flags: LineItemFlag[] = [];
  if (item.agentSuggested) flags.push("agent_suggested");
  if (item.quantity == null) flags.push("missing_quantity");
  if (item.unitPrice == null && item.totalPrice == null && !item.manuallyEdited)
    flags.push("unmatched");
  if (isEstimatedPrice(item) && !item.manuallyEdited) flags.push("estimated_price");
  if (item.manuallyEdited) flags.push("manually_edited");
  return flags;
}

/** Manually entered total wins; otherwise qty × unit price; otherwise nothing to add. */
export function effectiveTotal(item: QuoteLineItem): number | null {
  const total = num(item.totalPrice);
  if (total != null) return total;
  const qty = num(item.quantity);
  const price = num(item.unitPrice);
  if (qty != null && price != null) return Math.round(qty * price * 100) / 100;
  return null;
}

/**
 * Catalog rows keyed by pricebook code, so a line can carry its product link.
 * Optional throughout: callers that don't supply it simply get `product: null`, which keeps
 * every existing call site working unchanged.
 */
export type CatalogIndex = Map<string, PricebookItem>;

function productFor(item: QuoteLineItem, catalog?: CatalogIndex): LineItemProduct | null {
  if (!item.pricebookCode || !catalog) return null;
  const row = catalog.get(item.pricebookCode);
  if (!row || row.source !== "HOME_DEPOT") return null;
  return {
    productId: row.externalId ?? null,
    link: row.externalLink ?? null,
    brand: row.brand ?? null,
    rating: row.rating == null ? null : Number(row.rating),
    packageQuantity: row.packageQuantity == null ? null : Number(row.packageQuantity),
    provisional: row.provisional,
  };
}

export function toLineItemDto(item: QuoteLineItem, catalog?: CatalogIndex): LineItemDto {
  return {
    id: item.id,
    description: item.description,
    quantity: num(item.quantity),
    unit: item.unit,
    unitPrice: num(item.unitPrice),
    totalPrice: effectiveTotal(item),
    pricebookCode: item.pricebookCode,
    product: productFor(item, catalog),
    // Kept separate from `product`, which means "verified catalog row". An estimate is neither
    // verified nor a row, and a client that renders them identically would erase the difference.
    priceEstimated: isEstimatedPrice(item),
    estimateLink: isEstimatedPrice(item) ? homeDepotSearchLink(item.searchTerm ?? item.description) : null,
    flags: flagsFor(item),
    ambiguousAction: (item.ambiguousAction as LineItemDto["ambiguousAction"]) ?? null,
    optionGroup: item.optionGroup ?? null,
    sortOrder: item.sortOrder,
  };
}

const round2 = (v: number) => Math.round(v * 100) / 100;

export function toQuoteDto(
  quote: Quote & { lineItems: QuoteLineItem[] },
  catalog?: CatalogIndex
): QuoteDto {
  const items = [...quote.lineItems].sort((a, b) => a.sortOrder - b.sortOrder);
  const dtos = items.map((i) => toLineItemDto(i, catalog));
  // Option groups are mutually exclusive alternatives: `total` covers base-scope lines only
  // and each group gets its own total. Summing alternatives billed customers for both —
  // observed on two real option-based quotes ($6,591 printed for a $3,430-or-$4,430 choice).
  const baseTotal = round2(
    dtos.filter((d) => !d.optionGroup).reduce((sum, d) => sum + (d.totalPrice ?? 0), 0)
  );
  const groups = [...new Set(dtos.map((d) => d.optionGroup).filter((g): g is string => !!g))];
  const optionTotals = groups.map((name) => {
    const total = round2(
      dtos.filter((d) => d.optionGroup === name).reduce((sum, d) => sum + (d.totalPrice ?? 0), 0)
    );
    return { name, total, combinedTotal: round2(baseTotal + total) };
  });
  return {
    id: quote.id,
    conversationId: quote.conversationId,
    status: quote.status,
    createdAt: quote.createdAt.toISOString(),
    updatedAt: quote.updatedAt.toISOString(),
    completedAt: quote.completedAt?.toISOString() ?? null,
    lineItems: dtos,
    total: baseTotal,
    optionTotals,
    blockingFlagCount: dtos.filter((d) =>
      d.flags.some((f) => (BLOCKING_FLAGS as readonly string[]).includes(f))
    ).length,
  };
}
