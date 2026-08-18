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
  // Priced via online-retailer fallback, unconfirmed (pricebook-config PRD US6): the price
  // came from Home Depot, not the client's own pricebook, so the technician must confirm or
  // edit it before the quote can be marked Completed. Cleared by priceConfirmed.
  "fallback_price",
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
  /**
   * Labor/diagnostic time rather than a purchasable material. The quote's markup percentage
   * applies to materials only, so this flag is what keeps labor out of it.
   */
  isLabor: boolean;
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
  /**
   * Review-screen price provenance (pricebook-config PRD US8): the named pricebook the
   * price came from, "Home Depot — online fallback" for fallback prices, and null for a
   * manually entered/edited price (the manually_edited flag carries that signal instead).
   * Never rendered on the exported customer document.
   */
  priceSource: string | null;
  /** Labor line (labor PRD): quantity is hours, unitPrice is the hourly rate. */
  labor: boolean;
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
   * The quote's materials markup percentage, for the Invoice tab's input field. Every price in
   * `lineItems` already has it applied, so nothing downstream should multiply by this again.
   * Deliberately the only markup number in the DTO: the PRD wants markup baked into line
   * prices with no subtotal → markup → total breakdown and no pre-markup price shown anywhere.
   */
  markupPercent: number;
  /**
   * Customer identification, per quote (PRD US1–US3). Free text, all optional, never
   * validated; null renders blank/omitted on documents — never a placeholder, never an error.
   */
  customerName: string | null;
  customerAddress: string | null;
  customerPhone: string | null;
  /**
   * Base-scope lines only, at their marked-up prices. Option-group lines are alternatives the
   * customer picks between, so they are NEVER part of this sum — see optionTotals.
   */
  total: number;
  /** Present (non-empty) only when the quote carries alternative option groups. */
  optionTotals: QuoteOptionTotal[];
  blockingFlagCount: number;
}

const num = (v: unknown): number | null => (v == null ? null : Number(v));

const round2 = (v: number) => Math.round(v * 100) / 100;

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

/** True when the line's price came from the Home Depot fallback (catalog resolve). */
export function isFallbackPrice(item: { pricebookCode: string | null }): boolean {
  return item.pricebookCode?.startsWith("HD-") === true;
}

export function flagsFor(item: QuoteLineItem): LineItemFlag[] {
  if (item.ambiguousAction) return ["ambiguous"];
  const flags: LineItemFlag[] = [];
  if (item.agentSuggested) flags.push("agent_suggested");
  if (item.quantity == null) flags.push("missing_quantity");
  if (item.unitPrice == null && item.totalPrice == null && !item.manuallyEdited)
    flags.push("unmatched");
  if (isEstimatedPrice(item) && !item.manuallyEdited) flags.push("estimated_price");
  if (isFallbackPrice(item) && !item.manuallyEdited && !item.priceConfirmed)
    flags.push("fallback_price");
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
 * The line's prices with a markup percentage applied. This is the ONE place markup arithmetic
 * happens; every total in this file sums marked-up line totals from here, so the app's total
 * and a document's printed line prices can never disagree.
 *
 * Labor is returned untouched — that boundary is the whole point of the feature. A zero
 * markup returns exactly what `unitPrice`/`effectiveTotal` return today.
 *
 * The unit price is marked up and rounded to cents FIRST, then multiplied by the quantity, so
 * a printed row always multiplies out: a technician who sees 3 × $12.10 must read $36.30. A
 * manually entered line total is marked up directly, keeping the same precedence
 * `effectiveTotal` uses — a hand-typed total deliberately isn't qty × unit price.
 *
 * That precedence is restated here rather than delegated, because the rounding has to happen
 * per unit before the multiply. check-markup.ts pins the two together: at 0% markup this must
 * return exactly what `effectiveTotal` does, so the pair cannot drift apart unnoticed.
 */
export function markedUpPrices(
  item: QuoteLineItem,
  markupPercent: number
): { unitPrice: number | null; totalPrice: number | null } {
  // EITHER labor flag exempts the line. Two columns mean the same thing after the markup and
  // labor-charges features landed independently: `is_labor` (markup PRD, set by the agent's
  // op) and `labor` (labor PRD, set by the labor-rate flow). Checking only one marked up
  // every labor line the other flow created — the exact silent overcharge this boundary
  // exists to prevent.
  // ponytail: collapse the two columns into one in a follow-up migration; until then this
  // OR is the single guarantee, and it covers rows already written by either flow.
  const m = item.isLabor || item.labor ? 1 : 1 + markupPercent / 100;
  const baseUnit = num(item.unitPrice);
  const unitPrice = baseUnit == null ? null : round2(baseUnit * m);
  const manualTotal = num(item.totalPrice);
  if (manualTotal != null) return { unitPrice, totalPrice: round2(manualTotal * m) };
  const qty = num(item.quantity);
  if (qty != null && unitPrice != null) return { unitPrice, totalPrice: round2(qty * unitPrice) };
  return { unitPrice, totalPrice: null };
}

/**
 * Inverse of `markedUpPrices` for ONE price submitted by a client.
 *
 * The Invoice tab's price fields display marked-up figures and commit exactly what they
 * display, while the column stores BASE prices. Without this the marked-up figure would be
 * stored as the new base and marked up again on the next read, compounding on every edit.
 *
 * Rounds to cents because the column is Decimal(12,2), so a hand-typed price can re-display a
 * cent off. That is the accepted cost of the PRD's rule that no pre-markup price is shown
 * anywhere, which leaves the marked-up field as the only place a price can be edited.
 */
export function stripMarkup(value: number, markupPercent: number, isLabor = false): number {
  if (isLabor || !markupPercent) return value;
  return round2(value / (1 + markupPercent / 100));
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

/** Pricebook names keyed by id, for the priceSource display. */
export type PricebookNameIndex = Map<number, string>;

function priceSourceFor(item: QuoteLineItem, bookNames?: PricebookNameIndex): string | null {
  // A technician's own number has no external source — the manually_edited flag carries
  // that signal; the source display stays blank (US8's one exception).
  if (item.manuallyEdited) return null;
  if (item.sourcePricebookId != null)
    return bookNames?.get(item.sourcePricebookId) ?? "Company pricebook";
  if (isFallbackPrice(item) || isEstimatedPrice(item)) return "Home Depot — online fallback";
  return null;
}

/**
 * `markupPercent` defaults to 0 only for callers that serialize a line without its quote in
 * hand; every real read goes through `toQuoteDto`, which passes the quote's actual percentage.
 * Marked-up prices are what the review screen and the documents alike are meant to show.
 *
 * Because those prices are also what the editable fields commit back, the write side has to
 * undo this — see `stripMarkup`.
 *
 * `bookNames` is display-only (the review screen's price-source label) and never affects a
 * price, so callers that don't have the index simply get `priceSource: null`.
 */
export function toLineItemDto(
  item: QuoteLineItem,
  catalog?: CatalogIndex,
  markupPercent = 0,
  bookNames?: PricebookNameIndex
): LineItemDto {
  const prices = markedUpPrices(item, markupPercent);
  return {
    id: item.id,
    description: item.description,
    quantity: num(item.quantity),
    unit: item.unit,
    unitPrice: prices.unitPrice,
    totalPrice: prices.totalPrice,
    pricebookCode: item.pricebookCode,
    isLabor: item.isLabor,
    product: productFor(item, catalog),
    // Kept separate from `product`, which means "verified catalog row". An estimate is neither
    // verified nor a row, and a client that renders them identically would erase the difference.
    priceEstimated: isEstimatedPrice(item),
    estimateLink: isEstimatedPrice(item) ? homeDepotSearchLink(item.searchTerm ?? item.description) : null,
    priceSource: priceSourceFor(item, bookNames),
    labor: item.labor,
    flags: flagsFor(item),
    ambiguousAction: (item.ambiguousAction as LineItemDto["ambiguousAction"]) ?? null,
    optionGroup: item.optionGroup ?? null,
    sortOrder: item.sortOrder,
  };
}

export function toQuoteDto(
  quote: Quote & { lineItems: QuoteLineItem[] },
  catalog?: CatalogIndex,
  bookNames?: PricebookNameIndex
): QuoteDto {
  const items = [...quote.lineItems].sort((a, b) => a.sortOrder - b.sortOrder);
  // Markup is a live multiplier, not a stored snapshot: it is applied here, on every read, so
  // a line added after the percentage was set gets it with no extra action and a changed
  // percentage re-reflects on every line at once. Labor lines pass through untouched.
  const markupPercent = Number(quote.markupPercent ?? 0);
  const dtos = items.map((i) => toLineItemDto(i, catalog, markupPercent, bookNames));
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
    markupPercent,
    customerName: quote.customerName ?? null,
    customerAddress: quote.customerAddress ?? null,
    customerPhone: quote.customerPhone ?? null,
    total: baseTotal,
    optionTotals,
    blockingFlagCount: dtos.filter((d) =>
      d.flags.some((f) => (BLOCKING_FLAGS as readonly string[]).includes(f))
    ).length,
  };
}
