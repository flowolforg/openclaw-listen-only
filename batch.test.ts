import { describe, it, expect, beforeEach } from "vitest";
import {
  appendToBatch,
  flushBatch,
  flushBatchWithEntries,
  formatBatchBlock,
  truncateBatchToTokenBudget,
  getBatchSize,
  clearAllBatches,
} from "./batch.js";
import type { ListenOnlyConfig } from "./types.js";

const config: ListenOnlyConfig = {
  enabled: true,
  silentBatching: { windowSeconds: 120, maxMessages: 5 },
};

function makeEntry(text: string, idx: number = 0) {
  return {
    timestamp: Date.now() + idx * 1000,
    senderId: `user${idx}`,
    displayName: `User ${idx}`,
    messageId: `msg${idx}`,
    text,
  };
}

beforeEach(() => {
  clearAllBatches();
});

describe("appendToBatch", () => {
  it("accumulates entries without flushing", () => {
    const r = appendToBatch({ sessionKey: "s1", entry: makeEntry("hello", 0), config });
    expect(r.flushed).toBe(false);
    expect(getBatchSize("s1")).toBe(1);
  });

  it("auto-flushes on maxMessages", () => {
    for (let i = 0; i < 4; i++) {
      appendToBatch({ sessionKey: "s1", entry: makeEntry(`msg ${i}`, i), config });
    }
    expect(getBatchSize("s1")).toBe(4);

    const r = appendToBatch({ sessionKey: "s1", entry: makeEntry("msg 4", 4), config });
    expect(r.flushed).toBe(true);
    expect(r.batchBlock).toContain("batch_context");
    expect(r.batchBlock).toContain('count="5"');
    expect(getBatchSize("s1")).toBe(0);
  });
});

describe("flushBatch", () => {
  it("returns undefined for empty batch", () => {
    expect(flushBatch("nonexistent")).toBeUndefined();
  });

  it("returns formatted block and clears batch", () => {
    appendToBatch({ sessionKey: "s1", entry: makeEntry("hello", 0), config });
    appendToBatch({ sessionKey: "s1", entry: makeEntry("world", 1), config });

    const block = flushBatch("s1");
    expect(block).toContain("hello");
    expect(block).toContain("world");
    expect(block).toContain('count="2"');
    expect(getBatchSize("s1")).toBe(0);
  });
});

describe("flushBatchWithEntries", () => {
  it("returns entries and block", () => {
    appendToBatch({ sessionKey: "s1", entry: makeEntry("test", 0), config });
    const result = flushBatchWithEntries("s1");
    expect(result).toBeDefined();
    expect(result!.entries).toHaveLength(1);
    expect(result!.block).toContain("test");
  });
});

describe("formatBatchBlock", () => {
  it("formats entries with XML wrapper", () => {
    const entries = [makeEntry("hello", 0), makeEntry("world", 1)];
    const block = formatBatchBlock(entries);
    expect(block).toMatch(/^<batch_context count="2">/);
    expect(block).toMatch(/<\/batch_context>$/);
    expect(block).toContain("hello");
    expect(block).toContain("world");
  });

  it("includes bot marker", () => {
    const entry = { ...makeEntry("bot msg", 0), isBot: true };
    const block = formatBatchBlock([entry]);
    expect(block).toContain("|bot|");
  });

  it("returns empty string for no entries", () => {
    expect(formatBatchBlock([])).toBe("");
  });
});

describe("truncateBatchToTokenBudget", () => {
  it("returns full block when within budget", () => {
    const entries = [makeEntry("short", 0)];
    const { block, droppedCount } = truncateBatchToTokenBudget({ entries, maxTokens: 1000 });
    expect(droppedCount).toBe(0);
    expect(block).toContain("short");
  });

  it("drops oldest entries to fit budget", () => {
    const entries = Array.from({ length: 10 }, (_, i) => makeEntry("x".repeat(100), i));
    const { block, droppedCount } = truncateBatchToTokenBudget({ entries, maxTokens: 200 });
    expect(droppedCount).toBeGreaterThan(0);
    expect(block.length / 4).toBeLessThanOrEqual(200);
  });

  it("returns empty when even single entry exceeds budget", () => {
    const entries = [makeEntry("x".repeat(1000), 0)];
    const { block, droppedCount } = truncateBatchToTokenBudget({ entries, maxTokens: 10 });
    expect(block).toBe("");
    expect(droppedCount).toBe(1);
  });
});
