import type { L1ExtractionResult } from "./l1.js";

const cooldowns = new Map<string, number>();

export type ProactiveInterjectionResult = {
  sent: boolean;
  reason?: string;
};

export async function handleProactiveInterjection(params: {
  l1Result: L1ExtractionResult;
  channelId: string;
  cooldownSeconds: number;
  sendReply: (params: { text: string; replyToId?: string }) => Promise<boolean>;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
}): Promise<ProactiveInterjectionResult> {
  const { l1Result, channelId, cooldownSeconds, sendReply, logger } = params;

  if (!l1Result.proactive) {
    return { sent: false, reason: "no_proactive_hint" };
  }

  const hint = l1Result.proactive;
  if (!hint.message.trim()) {
    return { sent: false, reason: "empty_message" };
  }

  const now = Date.now();
  const lastSent = cooldowns.get(channelId);
  if (lastSent && now - lastSent < cooldownSeconds * 1000) {
    const remainingSeconds = Math.ceil((cooldownSeconds * 1000 - (now - lastSent)) / 1000);
    return { sent: false, reason: `cooldown:${remainingSeconds}s_remaining` };
  }

  try {
    const success = await sendReply({
      text: hint.message,
      replyToId: hint.replyToMessageId || undefined,
    });

    if (success) {
      cooldowns.set(channelId, now);
      logger?.info(`listen-only: proactive interjection sent to ${channelId}`);
      return { sent: true };
    }

    return { sent: false, reason: "send_failed" };
  } catch (err) {
    logger?.warn(`listen-only: proactive send failed: ${String(err)}`);
    return { sent: false, reason: `error:${String(err)}` };
  }
}

export function clearAllCooldowns(): void {
  cooldowns.clear();
}
