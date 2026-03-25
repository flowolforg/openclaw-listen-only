import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
/**
 * Listen-Only Mode Extension
 *
 * Pre-LLM gate for group chats: silently batch non-trigger messages,
 * log them to L0, extract memory via L1, and optionally interject proactively.
 *
 * Per-agent: each agent can enable/disable listen-only independently.
 * L0/L1 data is stored in the agent's workspace directory.
 *
 * The plugin is the sole gate/batch/L0 path. Core dispatch defers to the
 * plugin's `inbound_claim` (gate + batch + L0) and `before_prompt_build`
 * (batch flush into prompt context) hooks. The L1 extraction service and
 * proactive interjection logic also live here. Shared data-layer utilities
 * (L0 append, L1 extraction, watermark) are in `src/auto-reply/reply/`
 * for use by heartbeat-runner and session-memory.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { appendToBatch, flushBatchWithEntries, truncateBatchToTokenBudget } from "./batch.js";
import type { BatchEntry } from "./batch.js";
import { evaluateGate } from "./gate.js";
import { appendL0Entry, readChannelMeta, readParticipants, resolveL0Dir } from "./l0.js";
import type { ChannelContext } from "./l0.js";
import { runL1Extraction, hasNewL0Entries, readExistingMemorySnippets } from "./l1.js";
import { incrementCounter, getCounter, initPersistence, flushCounters } from "./metrics.js";
import { handleProactiveInterjection } from "./proactive.js";
import type { ListenOnlyConfig } from "./types.js";

// =============================================================================
// Agent session key parsing (mirrors core parseAgentSessionKey)
// =============================================================================

function parseAgentId(sessionKey: string | undefined): string | undefined {
  const raw = (sessionKey ?? "").trim().toLowerCase();
  if (!raw) return undefined;
  const parts = raw.split(":").filter(Boolean);
  if (parts.length < 3 || parts[0] !== "agent") return undefined;
  return parts[1]?.trim() || undefined;
}

/**
 * Extract the conversationId portion from a full session key.
 * Session key format: agent:<agentId>:<channel>:<conversationId...>
 * The conversationId may itself contain colons (e.g. "-100123:topic:42").
 */
function extractConversationId(sessionKey: string | undefined): string | undefined {
  if (!sessionKey) return undefined;
  const parts = sessionKey.split(":");
  // Need at least agent:<id>:<channel>:<conversationId>
  if (parts.length < 4 || parts[0] !== "agent") return undefined;
  return parts.slice(3).join(":");
}

/**
 * Strip common session key prefixes (group:, channel:, user:, chat:, dm:)
 * that the core session store adds but event.conversationId may lack.
 */
function stripSessionPrefix(key: string): string {
  for (const prefix of ["group:", "channel:", "user:", "chat:", "dm:"]) {
    if (key.startsWith(prefix)) {
      return key.slice(prefix.length);
    }
  }
  return key;
}

// =============================================================================
// Per-agent config + workspace resolution
// =============================================================================

type AgentListenOnlyResolved = {
  config: ListenOnlyConfig;
  workspaceDir: string;
  agentId: string;
  /** Base config before per-channel override (used for channel-specific merging). */
  baseConfig: ListenOnlyConfig;
};

function resolveAgentListenOnly(
  agentId: string,
  pluginCfg: ListenOnlyConfig,
  mainCfg: Record<string, unknown>,
  api: OpenClawPluginApi,
): AgentListenOnlyResolved | undefined {
  // 1. Resolve listen-only config for this agent (plugin config only)
  const lo = resolveAgentConfig(agentId, pluginCfg);
  if (!lo?.enabled) return undefined;

  // 2. Resolve workspace dir for this agent
  const workspaceDir = resolveAgentWorkspaceDir(agentId, lo, mainCfg, api);
  if (!workspaceDir) return undefined;

  return { config: lo, baseConfig: lo, workspaceDir, agentId };
}

function resolveAgentConfig(
  agentId: string,
  pluginCfg: ListenOnlyConfig,
): ListenOnlyConfig | undefined {
  // 1. Per-agent override within plugin config
  const agentOverride = pluginCfg.perAgent?.[agentId];
  if (agentOverride !== undefined) {
    // Merge: agent override inherits global plugin defaults
    return {
      ...pluginCfg,
      ...agentOverride,
      perAgent: undefined,
      perChannel: pluginCfg.perChannel,
    };
  }

  // 2. Global plugin config
  return pluginCfg;
}

/**
 * Apply per-channel overrides on top of the agent config.
 * Keys in perChannel are matched against channelId (exact or prefix match).
 */
function resolveChannelConfig(
  baseConfig: ListenOnlyConfig,
  channelId: string | undefined,
): ListenOnlyConfig {
  if (!channelId || !baseConfig.perChannel) return baseConfig;
  // Try exact match first, then prefix match (e.g. "telegram:" matches all Telegram channels)
  const override =
    baseConfig.perChannel[channelId] ??
    Object.entries(baseConfig.perChannel).find(([key]) => channelId.startsWith(key))?.[1];
  if (!override) return baseConfig;
  return { ...baseConfig, ...override, perAgent: undefined, perChannel: undefined };
}

function resolveAgentWorkspaceDir(
  agentId: string,
  lo: ListenOnlyConfig,
  mainCfg: Record<string, unknown>,
  api: OpenClawPluginApi,
): string | undefined {
  // 1. Explicit dataDir in plugin config
  if (lo.dataDir) {
    return api.resolvePath(lo.dataDir);
  }

  // 2. Agent-specific workspaceDir from agents.list[]
  const agents = (mainCfg as Record<string, unknown>).agents as Record<string, unknown> | undefined;
  const list = (agents?.list ?? []) as Record<string, unknown>[];
  const agentEntry = list.find(
    (a) =>
      (a.id as string)?.trim().toLowerCase() === agentId ||
      (a.name as string)?.trim().toLowerCase() === agentId,
  );
  const agentWs = agentEntry?.workspaceDir as string | undefined;
  if (agentWs) {
    return api.resolvePath(agentWs);
  }

  // 3. agents.defaults.workspaceDir
  const defaults = agents?.defaults as Record<string, unknown> | undefined;
  const defaultWs = defaults?.workspaceDir as string | undefined;
  if (defaultWs) {
    return api.resolvePath(defaultWs);
  }

  // 4. Convention: ~/.openclaw/workspace-<agentId>
  return api.resolvePath(`~/.openclaw/workspace-${agentId}`);
}

// =============================================================================
// Group memory context builder (qmd fallback)
// =============================================================================

/**
 * Build a context block with channel info + L1 summaries for injection into
 * the trigger prompt. Serves as fallback when qmd memory search is unavailable.
 *
 * Token budget: ~2000 tokens total (channel info ~200, recent summaries ~1500, older ~300)
 */
function buildGroupMemoryBlock(
  resolved: AgentListenOnlyResolved,
  conversationKey: string,
): string | null {
  const { workspaceDir } = resolved;
  // Derive channelId from conversation key (strip session prefixes)
  const channelId = stripSessionPrefix(conversationKey).replace(/[^a-zA-Z0-9_.-]/g, "_");
  const l0Dir = resolveL0Dir(workspaceDir, channelId);

  const parts: string[] = [];

  // 1. Channel info block
  const meta = readChannelMeta(l0Dir);
  const participantsData = readParticipants(l0Dir);
  if (meta || participantsData) {
    const infoLines: string[] = [];
    const title = meta?.title ?? channelId;
    const platform = meta?.channel ? ` (${meta.channel})` : "";
    infoLines.push(`Group: ${title}${platform}`);

    if (participantsData?.participants) {
      const people = Object.values(participantsData.participants)
        .filter((p) => !p.isBot)
        .map((p) => {
          const username = p.username ? ` (@${p.username})` : "";
          return `${p.displayName}${username}`;
        });
      if (people.length > 0) {
        infoLines.push(`Participants: ${people.join(", ")}`);
      }
    }

    parts.push(`<channel_info>\n${infoLines.join("\n")}\n</channel_info>`);
  }

  // 2. L1 summaries (recent + older, token-budgeted)
  const snippets = readExistingMemorySnippets(workspaceDir, channelId, 6000);
  if (snippets) {
    parts.push(`<group_memory>\n${snippets}\n</group_memory>`);
  }

  if (parts.length === 0) return null;
  return parts.join("\n\n");
}

// =============================================================================
// Plugin registration
// =============================================================================

export default function register(api: OpenClawPluginApi) {
  const cfg = api.config;
  const pluginCfg = (api.pluginConfig ?? {}) as ListenOnlyConfig;

  // Quick check: is listen-only potentially enabled for any agent?
  // (We register hooks unconditionally and check per-agent in the hook)
  if (pluginCfg.enabled === false && pluginCfg.forceOff) {
    api.logger.debug("listen-only: globally force-off, skipping registration");
    return;
  }

  // Resolve ownerAllowFrom from main config (for owner_voice / owner_image triggers)
  const ownerAllowFrom = resolveOwnerAllowFrom(cfg);

  // Cache resolved agent configs to avoid repeated lookups
  const agentCache = new Map<string, AgentListenOnlyResolved | null>();

  function getAgentResolved(agentId: string): AgentListenOnlyResolved | null {
    if (agentCache.has(agentId)) return agentCache.get(agentId)!;
    const resolved = resolveAgentListenOnly(agentId, pluginCfg, cfg, api) ?? null;
    agentCache.set(agentId, resolved);
    return resolved;
  }

  api.logger.info("listen-only: registering hooks");

  // =========================================================================
  // Hook: inbound_claim — gate logic (per-agent)
  // =========================================================================
  api.on("inbound_claim", (event, ctx) => {
    // Derive agentId from conversationId or senderId context
    // inbound_claim fires before agent routing, so we check all configured agents
    const metadata = (event.metadata ?? {}) as Record<string, unknown>;

    // Resolve the agent for this message. Prefer metadata.agentId when available
    // (set by routing); fall back to iterating configured agents.
    const agents = (cfg as Record<string, unknown>).agents as Record<string, unknown> | undefined;
    const list = (agents?.list ?? []) as Record<string, unknown>[];

    let matchedAgent: AgentListenOnlyResolved | null = null;
    const metaAgentId = (metadata.agentId as string)?.trim().toLowerCase();
    if (metaAgentId) {
      matchedAgent = getAgentResolved(metaAgentId);
    }
    if (!matchedAgent) {
      // Fall back: find first agent with listen-only enabled.
      for (const agentEntry of list) {
        const id = ((agentEntry.id as string) ?? (agentEntry.name as string) ?? "")
          .trim()
          .toLowerCase();
        if (!id) continue;
        const resolved = getAgentResolved(id);
        if (resolved) {
          matchedAgent = resolved;
          break;
        }
      }
    }

    if (!matchedAgent) return; // No agent has listen-only enabled → passthrough

    // Apply per-channel config override (e.g. different triggers per group)
    const channelId = event.conversationId ?? ctx.conversationId;
    const lo = resolveChannelConfig(matchedAgent.config, channelId);
    const agentId = matchedAgent.agentId;
    const mediaTypes = metadata.mediaType ? [metadata.mediaType as string] : undefined;
    // Derive senderIsBot from event/metadata when available.
    const senderIsBot = Boolean(
      (event as Record<string, unknown>).senderIsBot ??
      metadata.isBot ??
      metadata.senderIsBot ??
      false,
    );

    // Derive bot names for text-based mention detection (Matrix, IRC).
    // selfBotId is the bot's user ID; also check metadata for bot display name.
    const selfBotNames: string[] = [];
    const botUsername = metadata.botUsername as string | undefined;
    if (botUsername) selfBotNames.push(botUsername);
    const botDisplayName = metadata.botDisplayName as string | undefined;
    if (botDisplayName) selfBotNames.push(botDisplayName);

    // Build channel context for L0 metadata enrichment (channel title, usernames, bot info).
    const channelContext: ChannelContext = {
      chatTitle: metadata.chatTitle as string | undefined,
      senderUsername: (metadata.senderUsername ?? metadata.username) as string | undefined,
      botUsername,
      botDisplayName,
    };

    const gateResult = evaluateGate({
      config: lo,
      isGroup: event.isGroup,
      senderId: event.senderId ?? ctx.senderId,
      senderIsBot,
      wasMentioned: event.wasMentioned,
      sessionKey: event.conversationId ?? ctx.conversationId,
      content: event.content,
      mediaTypes,
      ownerAllowFrom,
      selfBotNames: selfBotNames.length > 0 ? selfBotNames : undefined,
    });

    api.logger.debug(
      `listen-only gate: agent=${agentId} action=${gateResult.action}` +
        `${(gateResult as { reason?: string }).reason ? ` reason=${(gateResult as { reason?: string }).reason}` : ""}` +
        ` group=${event.isGroup} sender=${event.senderId ?? "?"} mentioned=${event.wasMentioned ?? false}`,
    );

    if (gateResult.action === "passthrough") {
      incrementCounter("gate_passthrough");
      return;
    }

    if (gateResult.action === "listen") {
      if (senderIsBot) {
        incrementCounter("bot_messages_received");
      }
      const entry: BatchEntry = {
        timestamp: event.timestamp ?? Date.now(),
        senderId: event.senderId ?? ctx.senderId ?? "unknown",
        displayName: event.senderName ?? event.senderId ?? "unknown",
        messageId: event.messageId ?? ctx.messageId ?? "",
        text: event.content,
        isBot: senderIsBot,
      };

      // Use conversationId as batch key
      const batchKey = event.conversationId ?? ctx.conversationId ?? "unknown";
      appendToBatch({ sessionKey: batchKey, entry, config: lo });

      // L0 logging — write to ALL agents with listen-only enabled, not just the matched one.
      // inbound_claim fires before agent routing, so we broadcast L0 to every agent's workspace.
      {
        const channelId = deriveChannelIdFromClaim(event, ctx, metadata);
        if (channelId) {
          for (const agentEntry of list) {
            const id = ((agentEntry.id as string) ?? (agentEntry.name as string) ?? "")
              .trim()
              .toLowerCase();
            if (!id) continue;
            const resolved = getAgentResolved(id);
            if (!resolved) continue;
            const agentLo = resolveChannelConfig(resolved.config, channelId);
            if (agentLo.memoryExtraction?.l0?.enabled === false) continue;
            void appendL0Entry({ workspaceDir: resolved.workspaceDir, channelId, entry, channelContext });
          }
          incrementCounter("l0_entries_written");
        }
      }

      incrementCounter("messages_listened");
      return { handled: true };
    }

    if (gateResult.action === "trigger") {
      incrementCounter("messages_triggered");
      incrementCounter("batches_flushed_trigger");

      // Log trigger message to L0 — broadcast to ALL agents with listen-only enabled.
      {
        const channelId = deriveChannelIdFromClaim(event, ctx, metadata);
        if (channelId) {
          const entry: BatchEntry = {
            timestamp: event.timestamp ?? Date.now(),
            senderId: event.senderId ?? ctx.senderId ?? "unknown",
            displayName: event.senderName ?? event.senderId ?? "unknown",
            messageId: event.messageId ?? ctx.messageId ?? "",
            text: event.content,
            isBot: senderIsBot,
          };
          for (const agentEntry of list) {
            const id = ((agentEntry.id as string) ?? (agentEntry.name as string) ?? "")
              .trim()
              .toLowerCase();
            if (!id) continue;
            const resolved = getAgentResolved(id);
            if (!resolved) continue;
            const agentLo = resolveChannelConfig(resolved.config, channelId);
            if (agentLo.memoryExtraction?.l0?.enabled === false) continue;
            void appendL0Entry({ workspaceDir: resolved.workspaceDir, channelId, entry, channelContext });
          }
        }
      }

      return; // don't claim — let normal dispatch handle it
    }
  });

  // =========================================================================
  // Hook: before_prompt_build — inject activation prompt + batch context
  // =========================================================================
  api.on("before_prompt_build", (event, ctx) => {
    const sessionKey = ctx.sessionKey;
    if (!sessionKey) return;

    // Resolve agent to check if listen-only is enabled for this session
    const agentId = parseAgentId(sessionKey);
    if (!agentId) return;
    const resolved = getAgentResolved(agentId);
    if (!resolved) return;

    // Inject listen-only system prompt context with reasoning-leak prevention
    const systemContext =
      "Activation: listen-only (you silently observe all messages; you are invoked only on explicit triggers like @mention. Recent chat context is provided as batch blocks.) " +
      "You are triggered because someone explicitly invoked you. Respond helpfully. Batch context blocks contain recent group chat messages you observed silently. " +
      "IMPORTANT: You are in a group chat. Never expose internal reasoning, chain-of-thought, or meta-commentary in your response. " +
      "Do not prefix your answer with labels like 'Reasoning:', 'Analysis:', 'Let me think...', or 'Chain of thought:'. Respond naturally as a participant.";

    // Batch key must match what inbound_claim used: event.conversationId.
    // Session key format: agent:<agentId>:<channel>:<prefix>:<conversationId...>
    // The session key may contain a prefix like "group:" that event.conversationId lacks.
    // Try the extracted key first, then strip common prefixes (group:, channel:, user:, chat:).
    const rawBatchKey = extractConversationId(sessionKey) ?? sessionKey;
    const batchData =
      flushBatchWithEntries(rawBatchKey) ?? flushBatchWithEntries(stripSessionPrefix(rawBatchKey));
    // Build group memory context (L1 summaries + channel info) as qmd fallback.
    // This ensures the bot has long-term memory even without qmd's search tool.
    let memoryBlock: string | null = null;
    try {
      memoryBlock = buildGroupMemoryBlock(resolved, rawBatchKey);
    } catch {
      // Non-fatal: don't let memory injection crash the prompt build.
    }

    if (!batchData || batchData.entries.length === 0) {
      return {
        appendSystemContext: systemContext,
        prependContext: memoryBlock || undefined,
      };
    }

    const maxBatchTokens = resolved.config.silentBatching?.maxBatchTokens ?? 2000;
    const { block, droppedCount } = truncateBatchToTokenBudget({
      entries: batchData.entries,
      maxTokens: maxBatchTokens,
    });

    if (droppedCount > 0) {
      incrementCounter("batch_entries_truncated", droppedCount);
    }

    // Combine: group memory first (older context), then batch (recent messages)
    const combinedContext = [memoryBlock, block].filter(Boolean).join("\n\n");

    return {
      appendSystemContext: systemContext,
      prependContext: combinedContext || undefined,
    };
  });

  // =========================================================================
  // Service: L1 extraction timer (iterates all agents)
  // =========================================================================
  const l1Enabled = pluginCfg.memoryExtraction?.l1?.enabled ?? false;
  if (l1Enabled) {
    const intervalMs = (pluginCfg.memoryExtraction!.l1!.intervalSeconds ?? 300) * 1000;
    const budgetTokens = pluginCfg.memoryExtraction!.l1!.budgetTokensPerRun ?? 4000;
    const proactiveEnabled = pluginCfg.proactive?.enabled ?? false;
    const proactiveCooldown = pluginCfg.proactive?.cooldownSeconds ?? 3600;

    let l1Timer: NodeJS.Timeout | null = null;

    api.registerService({
      id: "listen-only.l1",
      start: async (ctx) => {
        // Pre-populate agentCache so L1 runs even without prior messages after restart
        const agents = (cfg as Record<string, unknown>).agents as
          | Record<string, unknown>
          | undefined;
        const list = (agents?.list ?? []) as Record<string, unknown>[];
        for (const agentEntry of list) {
          const id = ((agentEntry.id as string) ?? (agentEntry.name as string) ?? "")
            .trim()
            .toLowerCase();
          if (id && !agentCache.has(id)) {
            getAgentResolved(id);
          }
        }

        // Initialize metrics persistence from first available workspace
        const firstAgent = [...agentCache.values()].find((a) => a !== null);
        if (firstAgent) {
          initPersistence(firstAgent.workspaceDir);
        }

        ctx.logger.info(
          `listen-only-l1: started (interval=${intervalMs}ms, agents=${[...agentCache.keys()].filter((k) => agentCache.get(k) !== null).join(",") || "none"})`,
        );

        const tick = async () => {
          try {
            const activeAgents = [...agentCache.entries()].filter(([, a]) => a !== null);
            ctx.logger.info(`listen-only-l1: tick (${activeAgents.length} agents)`);

            // Relay health check: warn if bots are configured but none received
            const botCount = getCounter("bot_messages_received");
            const listenCount = getCounter("messages_listened");
            if (listenCount > 20 && botCount === 0 && pluginCfg.ignoreKnownBotIds?.length) {
              ctx.logger.warn(
                `listen-only-l1: relay health: ${listenCount} messages listened but 0 bot messages received ` +
                  `(${pluginCfg.ignoreKnownBotIds.length} bot IDs configured) — bot relay may be down`,
              );
            }

            // Iterate all cached agents that have listen-only enabled
            for (const [, agent] of agentCache) {
              if (!agent) continue;
              if (agent.config.memoryExtraction?.l1?.enabled === false) continue;

              await runL1ForAllChannels({
                workspaceDir: agent.workspaceDir,
                agentId: agent.agentId,
                budgetTokens,
                proactiveEnabled,
                proactiveCooldown,
                api,
                logger: ctx.logger,
              });
            }
          } catch (err) {
            ctx.logger.error(`listen-only-l1 tick failed: ${String(err)}`);
          }
          // Persist metrics to disk after each tick
          flushCounters();
        };

        l1Timer = setInterval(tick, intervalMs);
        l1Timer.unref?.();
      },
      stop: async (ctx) => {
        if (l1Timer) {
          clearInterval(l1Timer);
          l1Timer = null;
        }
        flushCounters();
        ctx.logger.info("listen-only-l1: stopped");
      },
    });
  }
}

// =============================================================================
// L1 extraction for all channels (per agent workspace)
// =============================================================================

async function runL1ForAllChannels(params: {
  workspaceDir: string;
  agentId: string;
  budgetTokens: number;
  proactiveEnabled: boolean;
  proactiveCooldown: number;
  api: OpenClawPluginApi;
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}): Promise<void> {
  const { workspaceDir, agentId, budgetTokens, proactiveEnabled, proactiveCooldown, api, logger } =
    params;
  const groupLogDir = join(workspaceDir, "memory", "group-log");

  if (!existsSync(groupLogDir)) return;

  let channelDirs: string[];
  try {
    channelDirs = readdirSync(groupLogDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return;
  }

  for (const channelId of channelDirs) {
    if (!hasNewL0Entries(workspaceDir, channelId)) continue;

    incrementCounter("l1_runs");
    logger.info(`listen-only-l1: processing ${agentId}/${channelId}`);
    try {
      const result = await runL1Extraction({
        workspaceDir,
        channelId,
        budgetTokens,
        existingMemorySnippets: readExistingMemorySnippets(workspaceDir, channelId),
        proactiveEnabled,
        llmCall: async (systemPrompt, userContent) => {
          // Direct OpenRouter API call with Gemini Flash for reliable JSON output.
          // We bypass subagent.run() because:
          // 1. subagent.run() uses the global subagent model (DeepSeek) which is poor at JSON
          // 2. L1 needs a model optimized for structured output, not general reasoning
          // 3. Gemini 2.0 Flash is cheaper AND more reliable for JSON than DeepSeek
          const l1Model: string = "google/gemini-2.0-flash-001";
          const l1ModelProv = l1Model.split("/")[0];
          const mProviders = ((api.config as Record<string, unknown>).models as Record<string, unknown> | undefined)
            ?.providers as Record<string, Record<string, unknown>> | undefined;
          const providerCfg: { baseUrl: string; apiKey: string } | null = (() => {
            for (const pk of ["openrouter", l1ModelProv]) {
              const p = mProviders?.[pk];
              if (p?.baseUrl && p?.apiKey) return { baseUrl: String(p.baseUrl), apiKey: String(p.apiKey) };
            }
            return null;
          })();
          if (!providerCfg) {
            // Fallback to subagent.run() if provider config not found
            const sessionKey = `agent:${agentId}:listen-only:l1-extraction:${channelId}`;
            try { await api.runtime.subagent.deleteSession({ sessionKey }); } catch { /* ok */ }
            const { runId } = await api.runtime.subagent.run({
              sessionKey, message: userContent, extraSystemPrompt: systemPrompt,
              idempotencyKey: `l1-${agentId}-${channelId}-${Date.now()}`,
            });
            await api.runtime.subagent.waitForRun({ runId, timeoutMs: 60_000 });
            const { messages } = await api.runtime.subagent.getSessionMessages({ sessionKey, limit: 1 });
            const last = messages[messages.length - 1] as Record<string, unknown> | undefined;
            if (!last) return "";
            const c = last.content;
            if (typeof c === "string") return c;
            if (Array.isArray(c)) return c.filter((b: unknown) => (b as Record<string, unknown>)?.type === "text").map((b: unknown) => String((b as Record<string, unknown>).text ?? "")).join("");
            return "";
          }

          const resp = await fetch(providerCfg.baseUrl + "/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${providerCfg.apiKey}`,
            },
            body: JSON.stringify({
              model: l1Model,
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userContent },
              ],
              response_format: { type: "json_object" },
              temperature: 0.6,
              max_tokens: 2048,
            }),
          });
          if (!resp.ok) {
            logger.warn(`listen-only-l1: API error ${resp.status} for ${agentId}/${channelId}`);
            return "";
          }
          const data = (await resp.json()) as Record<string, unknown>;
          const choices = data.choices as Record<string, unknown>[] | undefined;
          const msg = choices?.[0]?.message as Record<string, unknown> | undefined;
          return String(msg?.content ?? "");
        },
      });

      if (!result) {
        logger.info(`listen-only-l1: no result for ${agentId}/${channelId}`);
        continue;
      }

      incrementCounter("l1_memory_entries", result.memory.length);
      logger.info(
        `listen-only-l1: extracted ${result.memory.length} entries for ${agentId}/${channelId}`,
      );

      // Handle proactive interjection
      if (result.proactive && proactiveEnabled) {
        const l0Dir = resolveL0Dir(workspaceDir, channelId);
        const meta = readChannelMeta(l0Dir);
        if (meta) {
          const proResult = await handleProactiveInterjection({
            l1Result: result,
            channelId,
            cooldownSeconds: proactiveCooldown,
            sendReply: async (sendParams) => {
              try {
                await api.runtime.subagent.run({
                  sessionKey: `agent:${agentId}:l1-proactive:${channelId}`,
                  message: sendParams.text,
                  idempotencyKey: `l1-proactive-${agentId}-${channelId}-${Date.now()}`,
                });
                return true;
              } catch {
                return false;
              }
            },
            logger,
          });
          if (proResult.sent) {
            incrementCounter("l1_proactive_sent");
          } else {
            incrementCounter("l1_proactive_suppressed");
          }
        }
      }
    } catch (err) {
      incrementCounter("l1_runs_failed");
      logger.warn(`listen-only-l1: extraction failed for ${agentId}/${channelId}: ${String(err)}`);
    }
  }
}

// =============================================================================
// Config resolution helpers
// =============================================================================

function resolveOwnerAllowFrom(cfg: Record<string, unknown>): (string | number)[] {
  const commands = (cfg as Record<string, unknown>).commands as Record<string, unknown> | undefined;
  return (commands?.ownerAllowFrom as (string | number)[] | undefined) ?? [];
}

function deriveChannelIdFromClaim(
  event: { channel: string; conversationId?: string; threadId?: string | number },
  ctx: { channelId: string; conversationId?: string },
  metadata: Record<string, unknown>,
): string | undefined {
  const provider = metadata.provider as string | undefined;
  const to = metadata.to as string | undefined;

  // Prefer conversationId when it contains topic/thread info for per-topic L0 separation.
  // The conversationId already encodes the thread (e.g. "-100123:topic:42") via core routing.
  if (event.conversationId) {
    if (provider) {
      const prefixed = event.conversationId.startsWith(`${provider}:`)
        ? event.conversationId
        : `${provider}:${event.conversationId}`;
      return prefixed;
    }
    return event.conversationId;
  }

  if (provider && to) {
    if (to.startsWith(`${provider}:`) || to.startsWith(`${provider}_`)) {
      return to;
    }
    return `${provider}:${to}`;
  }
  return ctx.conversationId ?? event.channel ?? ctx.channelId ?? undefined;
}
