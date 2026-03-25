import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export type Watermark = {
  offset: number;
  timestamp: string;
  date: string;
};

export function readWatermark(l0Dir: string): Watermark | undefined {
  const filePath = join(l0Dir, ".watermark");
  try {
    if (!existsSync(filePath)) {
      return undefined;
    }
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Watermark;
    if (
      typeof parsed.offset === "number" &&
      typeof parsed.timestamp === "string" &&
      typeof parsed.date === "string"
    ) {
      return parsed;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function writeWatermark(l0Dir: string, watermark: Watermark): void {
  const filePath = join(l0Dir, ".watermark");
  try {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(filePath, JSON.stringify(watermark, null, "\t") + "\n", "utf-8");
  } catch {
    // Best-effort write.
  }
}
