/**
 * Listen-Only mode metrics counters with optional file persistence.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

const counters = new Map<string, number>();
let persistPath: string | null = null;
let dirty = false;

export type ListenOnlyMetricName =
  | "messages_listened"
  | "messages_triggered"
  | "batches_flushed_trigger"
  | "l0_entries_written"
  | "l1_runs"
  | "l1_runs_failed"
  | "l1_memory_entries"
  | "l1_proactive_sent"
  | "l1_proactive_suppressed"
  | "rate_limit_hits"
  | "gate_passthrough"
  | "bot_messages_filtered"
  | "bot_messages_received"
  | "batch_entries_truncated";

export function incrementCounter(name: ListenOnlyMetricName, amount: number = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + amount);
  dirty = true;
}

export function getCounter(name: ListenOnlyMetricName): number {
  return counters.get(name) ?? 0;
}

export function getAllCounters(): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, value] of counters) {
    result[key] = value;
  }
  return result;
}

export function resetAllCounters(): void {
  counters.clear();
  dirty = true;
}

/**
 * Initialize persistence: load counters from disk and set the persist path.
 * Call once at gateway startup with a workspace directory.
 */
export function initPersistence(workspaceDir: string): void {
  persistPath = join(workspaceDir, "memory", "listen-only-metrics.json");
  try {
    if (existsSync(persistPath)) {
      const raw = readFileSync(persistPath, "utf-8");
      const saved = JSON.parse(raw) as Record<string, number>;
      for (const [key, value] of Object.entries(saved)) {
        if (typeof value === "number" && Number.isFinite(value)) {
          counters.set(key, value);
        }
      }
    }
  } catch {
    // Corrupted file or parse error — start fresh
  }
  dirty = false;
}

/**
 * Flush dirty counters to disk. Call periodically (e.g. on L1 tick).
 * Fire-and-forget: write errors are silently ignored.
 */
export function flushCounters(): void {
  if (!dirty || !persistPath) return;
  try {
    const dir = dirname(persistPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(persistPath, JSON.stringify(getAllCounters()) + "\n", "utf-8");
    dirty = false;
  } catch {
    // Fire-and-forget
  }
}
