import { Quote, QuoteLineItem } from "@prisma/client";

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
] as const;

export type LineItemFlag = (typeof BLOCKING_FLAGS)[number] | "manually_edited";

export interface LineItemDto {
  id: string;
  description: string;
  quantity: number | null;
  unit: string | null;
  unitPrice: number | null;
  totalPrice: number | null;
  pricebookCode: string | null;
  flags: LineItemFlag[];
  ambiguousAction: {
    action: "remove" | "update";
    candidateItemIds: string[];
    referenceText: string;
    fields?: { description?: string; quantity?: number; unit?: string };
  } | null;
  sortOrder: number;
}

export interface QuoteDto {
  id: string;
  conversationId: string;
  status: "DRAFT" | "COMPLETED";
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  lineItems: LineItemDto[];
  total: number;
  blockingFlagCount: number;
}

const num = (v: unknown): number | null => (v == null ? null : Number(v));

export function flagsFor(item: QuoteLineItem): LineItemFlag[] {
  if (item.ambiguousAction) return ["ambiguous"];
  const flags: LineItemFlag[] = [];
  if (item.agentSuggested) flags.push("agent_suggested");
  if (item.quantity == null) flags.push("missing_quantity");
  if (item.unitPrice == null && item.totalPrice == null && !item.manuallyEdited)
    flags.push("unmatched");
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

export function toLineItemDto(item: QuoteLineItem): LineItemDto {
  return {
    id: item.id,
    description: item.description,
    quantity: num(item.quantity),
    unit: item.unit,
    unitPrice: num(item.unitPrice),
    totalPrice: effectiveTotal(item),
    pricebookCode: item.pricebookCode,
    flags: flagsFor(item),
    ambiguousAction: (item.ambiguousAction as LineItemDto["ambiguousAction"]) ?? null,
    sortOrder: item.sortOrder,
  };
}

export function toQuoteDto(quote: Quote & { lineItems: QuoteLineItem[] }): QuoteDto {
  const items = [...quote.lineItems].sort((a, b) => a.sortOrder - b.sortOrder);
  const dtos = items.map(toLineItemDto);
  return {
    id: quote.id,
    conversationId: quote.conversationId,
    status: quote.status,
    createdAt: quote.createdAt.toISOString(),
    updatedAt: quote.updatedAt.toISOString(),
    completedAt: quote.completedAt?.toISOString() ?? null,
    lineItems: dtos,
    total:
      Math.round(
        dtos.reduce((sum, d) => sum + (d.totalPrice ?? 0), 0) * 100
      ) / 100,
    blockingFlagCount: dtos.filter((d) =>
      d.flags.some((f) => (BLOCKING_FLAGS as readonly string[]).includes(f))
    ).length,
  };
}
