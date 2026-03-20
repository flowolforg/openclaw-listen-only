export type ListenOnlyTrigger = "mention" | "owner_voice" | "owner_image" | "explicit_command";

export type ListenOnlyConfig = {
  enabled?: boolean;
  forceOff?: boolean;
  triggers?: ListenOnlyTrigger[];
  rateLimit?: { maxRepliesPerWindow?: number; windowSeconds?: number };
  historyLimit?: number;
  compactionThreshold?: number;
  silentBatching?: {
    enabled?: boolean;
    windowSeconds?: number;
    maxMessages?: number;
    maxBatchTokens?: number;
  };
  ignoreSelf?: boolean;
  ignoreKnownBotIds?: string[];
  onlyHumanTriggers?: boolean;
  memoryExtraction?: {
    l0?: {
      enabled?: boolean;
      retentionDays?: number;
      compressAfterDays?: number;
      pseudonymize?: boolean;
    };
    l1?: {
      enabled?: boolean;
      model?: string;
      strategy?: string;
      budgetTokensPerRun?: number;
      intervalSeconds?: number;
      deduplication?: boolean;
    };
  };
  proactive?: { enabled?: boolean; categories?: string[]; cooldownSeconds?: number };
  dataDir?: string;
  /** Per-agent overrides. Keys are agent IDs (lowercase). */
  perAgent?: Record<string, ListenOnlyConfig>;
  /** Per-channel overrides. Keys are channel/conversationId patterns (e.g. "telegram:-100123"). */
  perChannel?: Record<string, Partial<ListenOnlyConfig>>;
};
