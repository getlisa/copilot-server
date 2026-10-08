import prisma from "./prisma";
import logger from "./logger";
import { syncQboReferenceData } from "./qboIngest";
import { qboConnected } from "./qbo";
import { syncZtData } from "./ztIngest";
import { ztConnected } from "./zt";
import { syncUptickData } from "./uptickIngest";
import { uptickConnected } from "./uptick";
import { syncServicetradeData } from "./servicetradeIngest";
import { servicetradeConnected } from "./servicetrade";
import { syncHcpData } from "./hcpIngest";
import { hcpConnected } from "./hcp";

/**
 * Daily sync of every connected integration — QuickBooks, ZenTrades, Uptick, ServiceTrade,
 * Housecall Pro — for every company, at 11:00 IST (05:30 UTC), one after another.
 *
 * Sequential on purpose: each sync fans out its own stages, and running every company's every
 * CRM at once is the load spike this exists to avoid. One failure (or an "already running" claim
 * from an admin's manual click) logs and moves on; nothing retries until the next day — the
 * Connections card's Sync button is the retry.
 *
 * setTimeout to the next 05:30 UTC, unref'd so it never holds the process open; no cron
 * dependency. ponytail: one ECS task runs this. If the service ever scales out, every task
 * fires — the per-company sync claims make that harmless (the second task sees "already
 * running"), only noisy; add a leader lock then. DAILY_SYNC_DISABLED=1 opts a dev box out.
 */

const RUN_AT_UTC = { hour: 5, minute: 30 }; // 11:00 IST
/** Gap between syncs so one company's run cools before the next starts. */
const PAUSE_BETWEEN_MS = 5_000;

let timer: NodeJS.Timeout | null = null;
let running = false;
let lastRunAt: Date | null = null;

export function msUntilNextRun(now = new Date()): number {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), RUN_AT_UTC.hour, RUN_AT_UTC.minute));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

type Job = { label: string; companyId: number; run: () => Promise<unknown> };

/** Every connected integration of every company, in a stable order (provider, then company). */
async function collectJobs(): Promise<Job[]> {
  const [qbo, zt, uptick, st, hcp] = await Promise.all([
    prisma.qboConnection.findMany(),
    prisma.ztConnection.findMany(),
    prisma.uptickConnection.findMany(),
    prisma.servicetradeConnection.findMany(),
    prisma.hcpConnection.findMany(),
  ]);
  return [
    ...qbo.filter(qboConnected).map((c) => ({ label: "quickbooks", companyId: c.companyId, run: () => syncQboReferenceData(c.companyId) })),
    ...zt.filter(ztConnected).map((c) => ({ label: "zentrades", companyId: c.companyId, run: () => syncZtData(c.companyId) })),
    ...uptick.filter(uptickConnected).map((c) => ({ label: "uptick", companyId: c.companyId, run: () => syncUptickData(c.companyId) })),
    ...st.filter(servicetradeConnected).map((c) => ({ label: "servicetrade", companyId: c.companyId, run: () => syncServicetradeData(c.companyId) })),
    ...hcp.filter(hcpConnected).map((c) => ({ label: "housecallpro", companyId: c.companyId, run: () => syncHcpData(c.companyId) })),
  ];
}

/** One full pass. Exported so an operator can trigger it by hand (and for the check script). */
export async function runDailySync(): Promise<{ ok: number; failed: number }> {
  if (running) {
    logger.warn("Daily sync pass skipped: previous pass still running");
    return { ok: 0, failed: 0 };
  }
  running = true;
  const startedAt = Date.now();
  let ok = 0;
  let failed = 0;
  try {
    const jobs = await collectJobs();
    logger.info("Daily sync pass starting", { jobs: jobs.length });
    for (const job of jobs) {
      const t0 = Date.now();
      try {
        const result = await job.run();
        ok++;
        logger.info("Daily sync done", { provider: job.label, companyId: job.companyId, ms: Date.now() - t0, result });
      } catch (e) {
        failed++;
        logger.error("Daily sync failed", {
          provider: job.label,
          companyId: job.companyId,
          ms: Date.now() - t0,
          error: e instanceof Error ? e.message : String(e),
        });
      }
      await new Promise((r) => setTimeout(r, PAUSE_BETWEEN_MS));
    }
  } finally {
    running = false;
    lastRunAt = new Date();
  }
  logger.info("Daily sync pass finished", { ok, failed, ms: Date.now() - startedAt });
  return { ok, failed };
}

function schedule(): void {
  const delay = msUntilNextRun();
  timer = setTimeout(async () => {
    try {
      await runDailySync();
    } catch (e) {
      logger.error("Daily sync pass threw", { error: e instanceof Error ? e.message : String(e) });
    }
    schedule();
  }, delay);
  timer.unref();
  logger.info("Daily sync scheduled", { nextRunUtc: new Date(Date.now() + delay).toISOString() });
}

/** Start the daily scheduler. Called once from server.ts. */
export function startDailySyncScheduler(): void {
  if (timer) return;
  if (!process.env.DATABASE_URL) {
    logger.info("Daily sync not started: no DATABASE_URL");
    return;
  }
  if (process.env.DAILY_SYNC_DISABLED === "1") {
    logger.info("Daily sync not started: DAILY_SYNC_DISABLED=1");
    return;
  }
  schedule();
}

export const dailySyncStatus = () => ({ started: timer !== null, running, lastRunAt: lastRunAt?.toISOString() ?? null });
