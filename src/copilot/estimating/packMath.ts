/**
 * Pack-aware quantities for the Estimating Agent.
 *
 * Home Depot sells many small electrical parts only in multiples: HD-100137321 is a 5-pack of
 * 1/2 in EMT set-screw connectors at $4.25, and $0.85 is what one costs, not what one can be
 * bought for. Pricing four of them at $3.40 quotes a purchase the supplier will not sell — the
 * technician leaves with five and the job is $0.85 short.
 *
 * So the QUANTITY is rounded up to a whole number of packs while the price stays per-unit:
 * 4 → 5 EA at $0.85 = $4.25. The line still reads as consistent arithmetic, and it matches
 * what actually gets bought. Storing the pack price against a pack unit would say the same
 * thing, but it inverts every unit price already in the book and turns a model-supplied "EA"
 * on a pack-priced row into a 5x overcharge.
 */

/** Units that count discrete pieces, so rounding up to a whole pack is meaningful. */
const COUNT_UNITS = new Set(["ea", "each", "pc", "pcs", "piece", "pieces", "unit", "units"]);

/** Home Depot writes units with a trailing period ("ft.", "ea.") — strip it before matching. */
const normalizeUnit = (unit: string) => unit.trim().toLowerCase().replace(/\.$/, "");

/** True when a unit counts pieces (or is absent, which the agent uses for plain counts). */
export function isCountUnit(unit: string | null | undefined): boolean {
  if (unit == null) return true;
  const u = normalizeUnit(unit);
  return u === "" || COUNT_UNITS.has(u);
}

/**
 * Units measuring length in feet — cable, conduit and the like. A supplier sells these in
 * fixed rolls/sticks ("100 ft. 14/2 NM-B"), so 25 ft needed means buying the whole 100 ft
 * roll, exactly like four connectors from a 5-pack.
 */
const LENGTH_UNITS = new Set(["ft", "foot", "feet", "lf", "lin ft", "linear ft", "linear feet"]);

export function isLengthUnit(unit: string | null | undefined): boolean {
  if (unit == null) return false;
  return LENGTH_UNITS.has(normalizeUnit(unit));
}

/**
 * Round a piece count up to a whole number of packs.
 *
 * Idempotent by construction — rounding an already-whole multiple returns it unchanged — so a
 * re-price, a backfill and a repair script can all run over the same line without compounding.
 * A missing quantity stays missing: the line is flagged for the technician, and inventing one
 * here would hide that.
 */
export function packRoundQty(
  quantity: number | null | undefined,
  packageQuantity: number | null | undefined
): number | null {
  if (quantity == null || !Number.isFinite(quantity) || quantity <= 0) {
    return quantity == null ? null : quantity;
  }
  if (packageQuantity == null || !Number.isFinite(packageQuantity) || packageQuantity <= 1) {
    return quantity;
  }
  return Math.ceil(quantity / packageQuantity) * packageQuantity;
}

/**
 * The quantity to store for a line priced against a pack row, or the original when rounding
 * would be a guess.
 *
 * Rounding is only meaningful when the line's unit and the pack's unit measure the same
 * thing: pieces against a count pack (4 connectors from a 5-pack → 5), or feet against a
 * roll measured in feet (25 ft of a 100 ft roll → 100). A measured unit next to a COUNT
 * pack is not something to convert confidently — "3 ft" of a 5-pack means nothing — so it
 * is left exactly as the technician gave it. A confident wrong conversion is the failure
 * this pipeline exists to prevent.
 *
 * `packUnit` is the priced row's own unit; omitted (the legacy callers) it means a count
 * pack, which preserves every behavior that existed before length packs.
 */
export function packAwareQuantity(
  quantity: number | null | undefined,
  unit: string | null | undefined,
  packageQuantity: number | null | undefined,
  packUnit?: string | null
): { quantity: number | null; rounded: boolean } {
  const original = quantity ?? null;
  const compatible = isLengthUnit(packUnit)
    ? isLengthUnit(unit)
    : isCountUnit(unit);
  if (!packageQuantity || packageQuantity <= 1 || !compatible) {
    return { quantity: original, rounded: false };
  }
  const next = packRoundQty(quantity, packageQuantity);
  return { quantity: next, rounded: next !== original };
}
