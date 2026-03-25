import { checkRateLimit } from "./rate-limit.js";
import type { ListenOnlyConfig } from "./types.js";

export type GateResult =
  | { action: "passthrough" }
  | { action: "trigger"; reason: string }
  | { action: "listen"; reason: string };

/**
 * Pre-LLM gate for listen-only mode.
 * Works with the plugin hook event fields (not FinalizedMsgContext).
 */
export function evaluateGate(params: {
  config: ListenOnlyConfig;
  isGroup: boolean;
  senderId?: string;
  senderIsBot?: boolean;
  wasMentioned?: boolean;
  sessionKey?: string;
  content: string;
  mediaTypes?: string[];
  ownerAllowFrom?: (string | number)[];
  selfBotId?: string;
  /** Bot username(s) for text-based mention detection (Matrix, IRC). */
  selfBotNames?: string[];
}): GateResult {
  const {
    config: lo,
    isGroup,
    senderId,
    senderIsBot,
    wasMentioned,
    sessionKey,
    content,
    mediaTypes,
    ownerAllowFrom,
    selfBotId,
    selfBotNames,
  } = params;

  // 1. forceOff → passthrough
  if (lo.forceOff) {
    return { action: "passthrough" };
  }

  // 2. Not a group chat → passthrough
  if (!isGroup) {
    return { action: "passthrough" };
  }

  // 3. Not enabled → passthrough
  if (!lo.enabled) {
    return { action: "passthrough" };
  }

  // 4. Own messages
  if (lo.ignoreSelf !== false && selfBotId && senderId === selfBotId) {
    return { action: "listen", reason: "self_message" };
  }

  // 5. Known bot IDs
  if (lo.ignoreKnownBotIds?.length && senderId) {
    if (lo.ignoreKnownBotIds.includes(senderId)) {
      return { action: "listen", reason: `known_bot:${senderId}` };
    }
  }

  // 6. Only human triggers
  if (lo.onlyHumanTriggers && senderIsBot) {
    return { action: "listen", reason: "bot_sender" };
  }

  // 7. Trigger checks
  const triggers = lo.triggers ?? ["mention"];

  for (const trigger of triggers) {
    switch (trigger) {
      case "mention":
        if (wasMentioned || isTextMention(content, selfBotNames)) {
          return applyRateLimit(sessionKey, lo, "mention");
        }
        break;

      case "owner_voice":
        if (isOwner(senderId, ownerAllowFrom) && isVoice(mediaTypes)) {
          return applyRateLimit(sessionKey, lo, "owner_voice");
        }
        break;

      case "owner_image":
        if (isOwner(senderId, ownerAllowFrom) && isImage(mediaTypes)) {
          return applyRateLimit(sessionKey, lo, "owner_image");
        }
        break;

      case "explicit_command":
        if (/^[!/]/.test(content.trim())) {
          return applyRateLimit(sessionKey, lo, "explicit_command");
        }
        break;
    }
  }

  // 8. No trigger matched
  return { action: "listen", reason: "no_trigger" };
}

function applyRateLimit(
  sessionKey: string | undefined,
  lo: ListenOnlyConfig,
  triggerReason: string,
): GateResult {
  if (!sessionKey) {
    return { action: "trigger", reason: triggerReason };
  }
  const maxReplies = lo.rateLimit?.maxRepliesPerWindow ?? 10;
  const windowSeconds = lo.rateLimit?.windowSeconds ?? 60;
  if (!checkRateLimit({ sessionKey, maxReplies, windowSeconds })) {
    return { action: "listen", reason: "rate_limited" };
  }
  return { action: "trigger", reason: triggerReason };
}

function isOwner(senderId: string | undefined, allowFrom?: (string | number)[]): boolean {
  if (!allowFrom?.length || !senderId) {
    return false;
  }
  return allowFrom.some((id) => String(id) === senderId);
}

function isVoice(mediaTypes?: string[]): boolean {
  if (!mediaTypes?.length) return false;
  return mediaTypes.some((t) => t === "audio" || t.startsWith("audio/") || t === "voice");
}

function isImage(mediaTypes?: string[]): boolean {
  if (!mediaTypes?.length) return false;
  return mediaTypes.some((t) => t === "image" || t.startsWith("image/"));
}

/**
 * Text-based mention detection for platforms without native wasMentioned
 * (Matrix @user:server.org, IRC nick highlights, plain @username).
 */
function isTextMention(content: string, botNames?: string[]): boolean {
  if (!botNames?.length) return false;
  const lower = content.toLowerCase();
  return botNames.some((name) => {
    const nameLower = name.toLowerCase();
    // Match @name or name: at word boundaries
    return (
      lower.includes(`@${nameLower}`) ||
      lower.startsWith(`${nameLower}:`) ||
      lower.startsWith(`${nameLower} `)
    );
  });
}
