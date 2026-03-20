import { existsSync, mkdirSync, appendFileSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BatchEntry } from "./batch.js";

export type ChannelMeta = {
  originalId: string;
  channel: string;
  title?: string;
  botUsername?: string;
  botDisplayName?: string;
  lastUpdated?: string;
};

export type ParticipantEntry = {
  senderId: string;
  displayName: string;
  username?: string;
  isBot?: boolean;
  firstSeen: string;
  lastSeen: string;
};

export type ParticipantsFile = {
  participants: Record<string, ParticipantEntry>;
};

/** Optional context from the inbound event for enriching channel/participant metadata. */
export type ChannelContext = {
  chatTitle?: string;
  senderUsername?: string;
  botUsername?: string;
  botDisplayName?: string;
};

export async function appendL0Entry(params: {
  workspaceDir: string;
  channelId: string;
  entry: BatchEntry;
  channelContext?: ChannelContext;
}): Promise<void> {
  const { workspaceDir, channelId, entry, channelContext } = params;
  const date = new Date(entry.timestamp);
  const dateStr = date.toISOString().slice(0, 10);
  const dir = resolveL0Dir(workspaceDir, channelId);

  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeChannelMeta(dir, channelId, channelContext);
    updateParticipants(dir, entry, channelContext);
    const filePath = join(dir, `${dateStr}.md`);
    const ts = date.toISOString();
    const botMarker = entry.isBot ? "|bot" : "";
    const line = `[${ts}|${entry.senderId}|${entry.displayName}${botMarker}|msg:${entry.messageId}] ${entry.text}\n`;
    appendFileSync(filePath, line, "utf-8");
  } catch {
    // Fire-and-forget: don't crash on write errors.
  }
}

const CHANNEL_META_FILE = "_channel-meta.json";
const PARTICIPANTS_FILE = "_participants.json";

function writeChannelMeta(
  dir: string,
  channelId: string,
  context?: ChannelContext,
): void {
  const metaPath = join(dir, CHANNEL_META_FILE);
  const colonIdx = channelId.indexOf(":");
  const channel = colonIdx > 0 ? channelId.slice(0, colonIdx) : "unknown";
  const now = new Date().toISOString();

  if (!existsSync(metaPath)) {
    // First write — create with all available context.
    const meta: ChannelMeta = {
      originalId: channelId,
      channel,
      title: context?.chatTitle,
      botUsername: context?.botUsername,
      botDisplayName: context?.botDisplayName,
      lastUpdated: now,
    };
    try {
      writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf-8");
    } catch {
      // Fire-and-forget.
    }
    return;
  }

  // Existing meta — update if context provides new/changed info.
  if (!context) return;
  const { chatTitle, botUsername, botDisplayName } = context;
  if (!chatTitle && !botUsername && !botDisplayName) return;

  try {
    const raw = readFileSync(metaPath, "utf-8");
    const existing = JSON.parse(raw) as ChannelMeta;
    let changed = false;

    if (chatTitle && existing.title !== chatTitle) {
      existing.title = chatTitle;
      changed = true;
    }
    if (botUsername && existing.botUsername !== botUsername) {
      existing.botUsername = botUsername;
      changed = true;
    }
    if (botDisplayName && existing.botDisplayName !== botDisplayName) {
      existing.botDisplayName = botDisplayName;
      changed = true;
    }

    if (changed) {
      existing.lastUpdated = now;
      writeFileSync(metaPath, JSON.stringify(existing, null, 2) + "\n", "utf-8");
    }
  } catch {
    // Fire-and-forget.
  }
}

function updateParticipants(
  dir: string,
  entry: BatchEntry,
  context?: ChannelContext,
): void {
  const filePath = join(dir, PARTICIPANTS_FILE);
  const now = new Date(entry.timestamp).toISOString();

  let data: ParticipantsFile;
  try {
    if (existsSync(filePath)) {
      const raw = readFileSync(filePath, "utf-8");
      data = JSON.parse(raw) as ParticipantsFile;
      if (!data.participants || typeof data.participants !== "object") {
        data = { participants: {} };
      }
    } else {
      data = { participants: {} };
    }
  } catch {
    data = { participants: {} };
  }

  const existing = data.participants[entry.senderId];
  if (existing) {
    // Update: refresh displayName, username, lastSeen.
    existing.displayName = entry.displayName;
    existing.lastSeen = now;
    if (context?.senderUsername && existing.username !== context.senderUsername) {
      existing.username = context.senderUsername;
    }
    if (entry.isBot !== undefined) {
      existing.isBot = entry.isBot;
    }
  } else {
    // New participant.
    data.participants[entry.senderId] = {
      senderId: entry.senderId,
      displayName: entry.displayName,
      username: context?.senderUsername,
      isBot: entry.isBot,
      firstSeen: now,
      lastSeen: now,
    };
  }

  try {
    writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  } catch {
    // Fire-and-forget.
  }
}

export function readChannelMeta(dir: string): ChannelMeta | null {
  const metaPath = join(dir, CHANNEL_META_FILE);
  try {
    const raw = readFileSync(metaPath, "utf-8");
    const parsed = JSON.parse(raw) as ChannelMeta;
    if (parsed.originalId && parsed.channel) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function readParticipants(dir: string): ParticipantsFile | null {
  const filePath = join(dir, PARTICIPANTS_FILE);
  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as ParticipantsFile;
  } catch {
    return null;
  }
}

function sanitizeChannelId(channelId: string): string {
  return channelId.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

export function resolveL0Dir(workspaceDir: string, channelId: string): string {
  return join(workspaceDir, "memory", "group-log", sanitizeChannelId(channelId));
}
