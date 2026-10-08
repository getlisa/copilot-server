import assert from "assert";
import { msUntilNextRun } from "../src/lib/syncScheduler";

/** Pins the 11:00 IST (05:30 UTC) schedule arithmetic. Pure.   npx tsx scripts/check-daily-sync.ts */
const H = 3_600_000;
// 04:30 UTC → one hour away, same day.
assert.strictEqual(msUntilNextRun(new Date("2026-10-08T04:30:00Z")), H);
// Exactly 05:30 UTC → next day (never fire twice for the same minute).
assert.strictEqual(msUntilNextRun(new Date("2026-10-08T05:30:00Z")), 24 * H);
// 06:00 UTC → 23.5h.
assert.strictEqual(msUntilNextRun(new Date("2026-10-08T06:00:00Z")), 23.5 * H);
// 11:00 IST is 05:30 UTC.
assert.strictEqual(new Date("2026-10-08T11:00:00+05:30").toISOString(), "2026-10-08T05:30:00.000Z");
console.log("ok   check-daily-sync: next-run arithmetic");
