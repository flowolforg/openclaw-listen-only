/**
 * Sliding-window rate limiter for listen-only trigger replies.
 */

const windows = new Map<string, number[]>();

export function checkRateLimit(params: {
  sessionKey: string;
  maxReplies: number;
  windowSeconds: number;
}): boolean {
  const { sessionKey, maxReplies, windowSeconds } = params;
  const now = Date.now();
  const cutoff = now - windowSeconds * 1000;

  let timestamps = windows.get(sessionKey);
  if (!timestamps) {
    timestamps = [];
    windows.set(sessionKey, timestamps);
  }

  const pruned = timestamps.filter((ts) => ts > cutoff);
  windows.set(sessionKey, pruned);

  if (pruned.length >= maxReplies) {
    return false;
  }

  pruned.push(now);
  return true;
}

export function clearAllRateLimits(): void {
  windows.clear();
}
