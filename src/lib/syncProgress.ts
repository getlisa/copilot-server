/**
 * Live sync progress for the Connections card, shared by every CRM sync (ZenTrades, Uptick,
 * ServiceTrade, Housecall Pro). Keyed by provider + company, then by stage (stages run
 * concurrently, so each keeps its own line; the card shows them joined). In-memory on purpose:
 * one server process serves this (single ECS task / local dev), and a lost progress line on
 * restart costs nothing. ponytail: move to the connection row if we ever scale out.
 */
export type SyncProvider = "zt" | "uptick" | "servicetrade" | "hcp";
export const SYNC_PROVIDERS: readonly SyncProvider[] = ["zt", "uptick", "servicetrade", "hcp"];

const progress = new Map<string, Map<string, string>>();
const keyOf = (provider: SyncProvider, companyId: number) => `${provider}:${companyId}`;

export const syncProgressFor = (provider: SyncProvider, companyId: number): string | null => {
  const stages = progress.get(keyOf(provider, companyId));
  return stages && stages.size > 0 ? [...stages.values()].join(" · ") : null;
};

export const setSyncProgress = (provider: SyncProvider, companyId: number, stage: string, msg: string) => {
  const k = keyOf(provider, companyId);
  let stages = progress.get(k);
  if (!stages) {
    stages = new Map();
    progress.set(k, stages);
  }
  stages.set(stage, msg);
};

export const clearSyncProgress = (provider: SyncProvider, companyId: number) => {
  progress.delete(keyOf(provider, companyId));
};
