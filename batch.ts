import type { ListenOnlyConfig } from "./types.js";

export type BatchEntry = {
  timestamp: number;
  senderId: string;
  displayName: string;
  messageId: string;
  text: string;
  isBot?: boolean;
};

type BatchState = {
  entries: BatchEntry[];
  createdAt: number;
};

const batches = new Map<string, BatchState>();

const DEFAULT_WINDOW_SECONDS = 120;
const DEFAULT_MAX_MESSAGES = 50;

export function appendToBatch(params: {
  sessionKey: string;
  entry: BatchEntry;
  config: ListenOnlyConfig;
}): { flushed: boolean; batchBlock?: string } {
  const { sessionKey, entry, config } = params;
  const batching = config.silentBatching;
  const windowMs = (batching?.windowSeconds ?? DEFAULT_WINDOW_SECONDS) * 1000;
  const maxMessages = batching?.maxMessages ?? DEFAULT_MAX_MESSAGES;

  let state = batches.get(sessionKey);
  if (!state) {
    state = { entries: [], createdAt: Date.now() };
    batches.set(sessionKey, state);
  }

  state.entries.push(entry);

  const windowExpired = Date.now() - state.createdAt >= windowMs;
  const capacityReached = state.entries.length >= maxMessages;

  if (windowExpired || capacityReached) {
    const block = formatBatchBlock(state.entries);
    batches.delete(sessionKey);
    return { flushed: true, batchBlock: block };
  }

  return { flushed: false };
}

export function flushBatch(sessionKey: string): string | undefined {
  const state = batches.get(sessionKey);
  if (!state || state.entries.length === 0) {
    return undefined;
  }
  const block = formatBatchBlock(state.entries);
  batches.delete(sessionKey);
  return block;
}

export function flushBatchWithEntries(
  sessionKey: string,
): { block: string; entries: BatchEntry[] } | undefined {
  const state = batches.get(sessionKey);
  if (!state || state.entries.length === 0) {
    return undefined;
  }
  const entries = [...state.entries];
  const block = formatBatchBlock(entries);
  batches.delete(sessionKey);
  return { block, entries };
}

export function formatBatchBlock(entries: BatchEntry[]): string {
  if (entries.length === 0) {
    return "";
  }
  const lines = entries.map((e) => {
    const ts = new Date(e.timestamp).toISOString();
    const botMarker = e.isBot ? "|bot" : "";
    return `[${ts}|${e.senderId}|${e.displayName}${botMarker}|msg:${e.messageId}] ${e.text}`;
  });
  return `<batch_context count="${entries.length}">\n${lines.join("\n")}\n</batch_context>`;
}

function estimateTokensFromChars(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4);
}

export function truncateBatchToTokenBudget(params: { entries: BatchEntry[]; maxTokens: number }): {
  block: string;
  droppedCount: number;
} {
  const { entries, maxTokens } = params;
  if (entries.length === 0) {
    return { block: "", droppedCount: 0 };
  }

  const fullBlock = formatBatchBlock(entries);
  if (estimateTokensFromChars(fullBlock.length) <= maxTokens) {
    return { block: fullBlock, droppedCount: 0 };
  }

  for (let start = 1; start < entries.length; start++) {
    const trimmed = formatBatchBlock(entries.slice(start));
    if (estimateTokensFromChars(trimmed.length) <= maxTokens) {
      return { block: trimmed, droppedCount: start };
    }
  }

  return { block: "", droppedCount: entries.length };
}

export function getBatchSize(sessionKey: string): number {
  return batches.get(sessionKey)?.entries.length ?? 0;
}

export function clearAllBatches(): void {
  batches.clear();
}
