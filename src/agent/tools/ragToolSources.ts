import { RagSource } from "../../types/agent.types";

type StoredSources = {
  sources: RagSource[];
  createdAt: number;
};

const MAX_AGE_MS = 10 * 60 * 1000;
const store = new Map<string, StoredSources>();

function cleanupExpired(): void {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const [runId, entry] of store.entries()) {
    if (entry.createdAt < cutoff) {
      store.delete(runId);
    }
  }
}

export function recordRagSources(runId: string, sources: RagSource[]): void {
  if (!runId || sources.length === 0) return;
  cleanupExpired();
  const existing = store.get(runId);
  if (existing) {
    existing.sources.push(...sources);
    return;
  }
  store.set(runId, { sources: [...sources], createdAt: Date.now() });
}

export function consumeRagSources(runId: string): RagSource[] {
  if (!runId) return [];
  cleanupExpired();
  const entry = store.get(runId);
  if (!entry) return [];
  store.delete(runId);
  return entry.sources;
}
