import { existsSync, readdirSync, readFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { resolveL0Dir, readChannelMeta, readParticipants } from "./l0.js";
import { readWatermark, writeWatermark, type Watermark } from "./watermark.js";

export type L1MemoryEntry = {
  fact: string;
  source: string;
  date: string;
  tags: string[];
};

export type L1ProactiveHint = {
  message: string;
  replyToMessageId: string;
};

export type L1ExtractionResult = {
  memory: L1MemoryEntry[];
  proactive: L1ProactiveHint | null;
};

const L1_SYSTEM_PROMPT = `You are an automatic memory extractor. You process chat logs and return structured JSON.

IMPORTANT: You are NOT a chatbot. You do NOT hold conversations. Even if the chat log contains questions, do NOT answer them. Your ONLY task is to extract facts from the log and output them as JSON.

## Storage criteria – WHAT to extract:

- Decisions, to-dos, appointments
- New facts about people/projects
- Recurring topics/terms
- Open questions / next steps
- Valuable research results from other agents

## Do NOT store:

- Small talk, mere pleasantries
- Repetitions, already stored points (see "Already known facts")
- Trivial coordination ("be right there", "ok")
- Bot commands or @mentions to bots

## Attribution rules

- Always attribute facts to the **human original source**, not a bot.
- Messages with \`|bot]\` or \`|bot|\` markers are summaries/derivations.
  Use them for confirmation, not as primary source.
- Exception: Bot provides independently new information (research, calculation)
  → attribute as "Research via [BotName]".

## Output format

Respond with EXACTLY one JSON object. No text before. No text after. No Markdown code blocks. Only pure JSON.

### Example input:
[2026-03-15T10:00:00.000Z|12345|Alice|msg:100] We should expand the EduClaw project to Matrix
[2026-03-15T10:01:00.000Z|67890|Bob|msg:101] Good idea, I'll handle the Matrix bridge setup by Friday
[2026-03-15T10:02:00.000Z|12345|Alice|msg:102] ok

### Example output:
{"memory": [{"fact": "EduClaw project to be expanded to Matrix", "source": "Alice", "date": "2026-03-15", "tags": ["educlaw", "matrix", "decision"]}, {"fact": "Bob takes over Matrix bridge setup, deadline Friday", "source": "Bob", "date": "2026-03-15", "tags": ["educlaw", "matrix", "todo"]}], "proactive": null}

### When nothing to extract:
{"memory": [], "proactive": null}`;

export async function runL1Extraction(params: {
  workspaceDir: string;
  channelId: string;
  budgetTokens: number;
  existingMemorySnippets: string;
  proactiveEnabled: boolean;
  llmCall: (systemPrompt: string, userContent: string) => Promise<string>;
}): Promise<L1ExtractionResult | null> {
  const { workspaceDir, channelId, budgetTokens, existingMemorySnippets, llmCall } = params;
  const l0Dir = resolveL0Dir(workspaceDir, channelId);

  if (!existsSync(l0Dir)) {
    return null;
  }

  const watermark = readWatermark(l0Dir);
  const l0Content = readL0EntriesSinceWatermark(l0Dir, watermark, budgetTokens);
  if (!l0Content.text.trim()) {
    return null;
  }

  const contextBlock = existingMemorySnippets
    ? `\n\nAlready known facts (do not repeat):\n${existingMemorySnippets}`
    : "";
  const proactiveBlock = params.proactiveEnabled
    ? `\n\nProactive interjection is enabled. Check CAREFULLY whether any of these cases apply:
- Factual error: Someone claims something incorrect (e.g. wrong day of week, wrong time, wrong date)
- Contradiction: Two statements in the log contradict each other
- Forgotten action: A to-do was mentioned but not completed
- Relevant context: You know something that would help the group
If any such case applies, the "proactive" field MUST be set.`
    : '\n\nProactive interjection is disabled. Always return "proactive": null.';
  const now = new Date();
  const dayNames = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
  const dateInfo = `Current date: ${now.toISOString().slice(0, 10)} (${dayNames[now.getDay()]})`;
  const userContent = `Channel: ${channelId}\n${dateInfo}${contextBlock}${proactiveBlock}\n\n## Chatverlauf\n\n${l0Content.text}`;

  let rawResponse: string;
  try {
    rawResponse = await llmCall(L1_SYSTEM_PROMPT, userContent);
  } catch (err) {
    console.warn(`listen-only-l1: llmCall failed for ${channelId}: ${String(err)}`);
    return null;
  }

  if (!rawResponse?.trim()) {
    console.warn(`listen-only-l1: empty llmCall response for ${channelId}`);
    return null;
  }

  const result = parseL1Response(rawResponse);
  if (!result) {
    console.warn(
      `listen-only-l1: parseL1Response failed for ${channelId}, raw=${rawResponse.slice(0, 200)}`,
    );
    // Advance watermark even on parse failure to avoid reprocessing the same block forever.
    writeWatermark(l0Dir, l0Content.newWatermark);
    return null;
  }

  if (result.memory.length > 0) {
    writeL1Summaries(workspaceDir, channelId, result.memory);
  }

  writeWatermark(l0Dir, l0Content.newWatermark);
  return result;
}

function readL0EntriesSinceWatermark(
  l0Dir: string,
  watermark: Watermark | undefined,
  budgetTokens: number,
): { text: string; newWatermark: Watermark } {
  const maxChars = budgetTokens * 4;
  const files = readdirSync(l0Dir)
    .filter((f) => f.endsWith(".md") && !f.startsWith("."))
    .toSorted();

  let accumulated = "";
  let lastDate = watermark?.date ?? "";
  let lastTimestamp = watermark?.timestamp ?? "";
  let lastOffset = watermark?.offset ?? 0;
  let startFromOffset = Boolean(watermark);

  for (const file of files) {
    const dateStr = file.replace(".md", "");
    if (watermark && dateStr < watermark.date) {
      continue;
    }
    const content = readFileSync(join(l0Dir, file), "utf-8");
    const lines = content.split("\n").filter(Boolean);

    let lineOffset = 0;
    for (const line of lines) {
      lineOffset++;
      if (startFromOffset && dateStr === watermark?.date && lineOffset <= watermark.offset) {
        continue;
      }
      startFromOffset = false;

      if (accumulated.length + line.length > maxChars) {
        return {
          text: accumulated,
          newWatermark: { offset: lineOffset - 1, timestamp: lastTimestamp, date: lastDate },
        };
      }
      accumulated += line + "\n";
      lastDate = dateStr;
      lastOffset = lineOffset;
      const tsMatch = line.match(/^\[([^\]|]+)/);
      if (tsMatch) {
        lastTimestamp = tsMatch[1];
      }
    }
  }

  return {
    text: accumulated,
    newWatermark: { offset: lastOffset, timestamp: lastTimestamp, date: lastDate },
  };
}

function parseL1Response(raw: string): L1ExtractionResult | null {
  try {
    // Strip all markdown code fences (including nested/multiple)
    let cleaned = raw.replace(/```(?:json)?\s*\n?/g, "").replace(/```/g, "");

    // Try to extract JSON object containing "memory" key
    const jsonMatch = cleaned.match(/\{[\s\S]*"memory"\s*:\s*\[[\s\S]*\}/);
    if (jsonMatch) {
      cleaned = jsonMatch[0];
    } else {
      // No JSON found at all — likely a conversational response
      return null;
    }

    // Balance braces: find the matching closing brace for the first opening brace
    let depth = 0;
    let end = -1;
    for (let i = 0; i < cleaned.length; i++) {
      if (cleaned[i] === "{") depth++;
      else if (cleaned[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end > 0) {
      cleaned = cleaned.slice(0, end);
    }

    const parsed = JSON.parse(cleaned.trim());
    if (!parsed || !Array.isArray(parsed.memory)) {
      return null;
    }
    return {
      memory: parsed.memory.map((m: L1MemoryEntry) => ({
        fact: String(m.fact ?? ""),
        source: String(m.source ?? ""),
        date: String(m.date ?? ""),
        tags: Array.isArray(m.tags) ? m.tags.map(String) : [],
      })),
      proactive: parsed.proactive
        ? {
            message: String(parsed.proactive.message ?? ""),
            replyToMessageId: String(parsed.proactive.replyToMessageId ?? ""),
          }
        : null,
    };
  } catch {
    return null;
  }
}

function writeL1Summaries(workspaceDir: string, channelId: string, entries: L1MemoryEntry[]): void {
  const sanitized = channelId.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const dir = join(workspaceDir, "memory", "group-summary", sanitized);
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const dateStr = new Date().toISOString().slice(0, 10);
    const filePath = join(dir, `${dateStr}.md`);

    // Write channel header on first write to this file (for qmd searchability).
    const isNewFile = !existsSync(filePath);
    const parts: string[] = [];

    if (isNewFile) {
      const header = buildChannelHeader(workspaceDir, channelId, dateStr);
      if (header) {
        parts.push(header);
      }
    }

    const lines = entries.map((e) => {
      const tagsStr = e.tags.length > 0 ? ` [${e.tags.join(", ")}]` : "";
      return `- ${e.fact} (Source: ${e.source}, ${e.date})${tagsStr}`;
    });
    parts.push(lines.join("\n"));
    appendFileSync(filePath, parts.join("\n") + "\n", "utf-8");
  } catch {
    // Best-effort write.
  }
}

/**
 * Build a Markdown header for L1 summary files.
 * Includes channel title and participant list from meta files,
 * making the summaries more useful for qmd semantic search.
 */
function buildChannelHeader(workspaceDir: string, channelId: string, dateStr: string): string | null {
  const l0Dir = resolveL0Dir(workspaceDir, channelId);
  const meta = readChannelMeta(l0Dir);
  const participantsData = readParticipants(l0Dir);

  const titlePart = meta?.title ?? channelId;
  const channelPart = meta?.channel ? ` (${meta.channel})` : "";
  const headerLines: string[] = [];

  headerLines.push(`# ${titlePart}${channelPart} — ${dateStr}`);
  headerLines.push("");

  if (participantsData?.participants) {
    const people = Object.values(participantsData.participants)
      .filter((p) => !p.isBot)
      .map((p) => {
        const username = p.username ? ` (@${p.username})` : "";
        return `${p.displayName}${username}`;
      });
    if (people.length > 0) {
      headerLines.push(`Participants: ${people.join(", ")}`);
      headerLines.push("");
    }
  }

  return headerLines.join("\n");
}

/**
 * Read existing L1 summaries for a channel to provide as dedup context.
 * Returns the most recent summary entries (up to charBudget characters).
 */
export function readExistingMemorySnippets(
  workspaceDir: string,
  channelId: string,
  charBudget: number = 4000,
): string {
  const sanitized = channelId.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const dir = join(workspaceDir, "memory", "group-summary", sanitized);
  if (!existsSync(dir)) return "";

  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .toSorted()
      .toReversed(); // newest first
    let accumulated = "";
    for (const file of files) {
      const content = readFileSync(join(dir, file), "utf-8");
      // Extract only the bullet-point lines (skip headers).
      const factLines = content
        .split("\n")
        .filter((line) => line.startsWith("- "))
        .join("\n");
      if (accumulated.length + factLines.length > charBudget) {
        // Add as much as fits.
        const remaining = charBudget - accumulated.length;
        if (remaining > 100) {
          accumulated += factLines.slice(0, remaining);
        }
        break;
      }
      accumulated += factLines + "\n";
    }
    return accumulated.trim();
  } catch {
    return "";
  }
}

export function hasNewL0Entries(workspaceDir: string, channelId: string): boolean {
  const l0Dir = resolveL0Dir(workspaceDir, channelId);
  if (!existsSync(l0Dir)) return false;

  const watermark = readWatermark(l0Dir);
  let files: string[];
  try {
    files = readdirSync(l0Dir)
      .filter((f) => f.endsWith(".md") && !f.startsWith("."))
      .toSorted();
  } catch {
    return false;
  }

  if (files.length === 0) return false;
  if (!watermark) return true;

  const lastFile = files[files.length - 1].replace(".md", "");
  if (lastFile > watermark.date) return true;

  if (lastFile === watermark.date) {
    try {
      const content = readFileSync(join(l0Dir, files[files.length - 1]), "utf-8");
      const lineCount = content.split("\n").filter(Boolean).length;
      return lineCount > watermark.offset;
    } catch {
      return false;
    }
  }

  return false;
}
