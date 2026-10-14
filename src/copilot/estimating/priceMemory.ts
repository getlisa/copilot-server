import prisma from "../../lib/prisma";
import logger from "../../lib/logger";
import type { PriceMemory } from "@prisma/client";
import { ESTIMATED_PRICE_CODE } from "./quoteDto";

/**
 * Organization price memory (price-memory PRD, 2026-10-08).
 *
 * A per-company store of prices learned from technicians who hold the learning permission
 * (`users.price_memory_learner`), for products that are NOT in the pricebook. Every technician
 * in the company reads from it. Order of authority: pricebook → memory → Home Depot fallback →
 * manual entry. A pricebook hit is final — memory is neither read nor written for it.
 *
 * Matching is on the line's DESCRIPTION, normalized (trim, collapse whitespace, lowercase) and
 * then exact. Never fuzzy: "PVC Pipe" and "pvc pipe" are one product; any other wording is a
 * new product (FR-11). Among active entries with the same key the newest `setAt` wins.
 */

/** Sentinel `pricebookCode` for a line priced from memory — same precedent as "EST". */
export const MEMORY_PRICE_CODE = "MEM";

export const memoryKey = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

/** True when the line's price came from a pricebook row (a company book or the HD cache). */
export const inPriceBook = (item: { pricebookCode: string | null }) =>
  item.pricebookCode != null &&
  item.pricebookCode !== ESTIMATED_PRICE_CODE &&
  item.pricebookCode !== MEMORY_PRICE_CODE;

/** Newest active entry per key, pure for the check script. */
export function indexMemory(rows: PriceMemory[]): Map<string, PriceMemory> {
  const byKey = new Map<string, PriceMemory>();
  for (const row of rows) {
    if (!row.isActive) continue;
    const cur = byKey.get(row.nameKey);
    if (!cur || row.setAt > cur.setAt) byKey.set(row.nameKey, row);
  }
  return byKey;
}

export async function loadPriceMemory(companyId: number): Promise<Map<string, PriceMemory>> {
  return indexMemory(await prisma.priceMemory.findMany({ where: { companyId, isActive: true } }));
}

/** The four line-item fields a memory hit sets. */
export const memoryPriceFields = (entry: PriceMemory) => ({
  unitPrice: Number(entry.rate),
  pricebookCode: MEMORY_PRICE_CODE,
  sourcePricebookId: null as number | null,
  priceMemoryId: entry.id,
});

/**
 * Save a technician's price to memory — only when they hold the learning permission (FR-5/8).
 * Callers have already established that the product is NOT in the pricebook. Returns the entry
 * id to store on the line, or null when nothing was learned.
 *
 *  - `fromMemoryId`: the entry that priced the line, when any. A learner changing that rate
 *    updates the SAME entry (FR-13); if it has since been disabled, a new active entry is
 *    created and the old one stays disabled (FR-18).
 *  - otherwise the newest active entry with the same key is updated, else one is created.
 */
export async function learnPrice(opts: {
  companyId: number;
  userId: string | bigint;
  name: string;
  description?: string | null;
  rate: number;
  isLabor: boolean;
  fromMemoryId?: number | null;
}): Promise<number | null> {
  if (!Number.isFinite(opts.rate) || opts.rate < 0) return null;
  const userId = BigInt(opts.userId);
  const user = await prisma.users.findUnique({
    where: { id: userId },
    select: { price_memory_learner: true },
  });
  if (!user?.price_memory_learner) return null;

  const nameKey = memoryKey(opts.name);
  const linked =
    opts.fromMemoryId != null
      ? await prisma.priceMemory.findFirst({
          where: { id: opts.fromMemoryId, companyId: opts.companyId, isActive: true },
        })
      : null;
  const target =
    linked ??
    (await prisma.priceMemory.findFirst({
      where: { companyId: opts.companyId, nameKey, isActive: true },
      orderBy: { setAt: "desc" },
    }));

  const data = {
    rate: opts.rate,
    isLabor: opts.isLabor,
    setByUserId: userId,
    setAt: new Date(),
    ...(opts.description ? { description: opts.description } : {}),
  };
  const entry = target
    ? await prisma.priceMemory.update({ where: { id: target.id }, data })
    : await prisma.priceMemory.create({
        data: { ...data, companyId: opts.companyId, name: opts.name.trim(), nameKey },
      });
  logger.info(target ? "Price memory updated" : "Price memory learned", {
    companyId: opts.companyId,
    userId: String(userId),
    entryId: entry.id,
    name: entry.name,
    rate: opts.rate,
  });
  return entry.id;
}

/** "set by Jane Doe on Oct 8, 2026" for the review screen's price-source label (FR-12). */
export type MemorySourceIndex = Map<number, string>;

export async function memorySourcesFor(
  lineItems: { priceMemoryId?: number | null }[]
): Promise<MemorySourceIndex> {
  const ids = [...new Set(lineItems.map((i) => i.priceMemoryId).filter((v): v is number => v != null))];
  if (ids.length === 0) return new Map();
  const entries = await prisma.priceMemory.findMany({
    where: { id: { in: ids } },
    select: { id: true, setByUserId: true, setAt: true },
  });
  const users = await prisma.users.findMany({
    where: { id: { in: [...new Set(entries.map((e) => e.setByUserId))] } },
    select: { id: true, first_name: true, last_name: true },
  });
  const nameOf = new Map(users.map((u) => [u.id, `${u.first_name} ${u.last_name}`.trim()]));
  return new Map(
    entries.map((e) => [
      e.id,
      `Organization memory — set by ${nameOf.get(e.setByUserId) ?? "a technician"} on ${e.setAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`,
    ])
  );
}
