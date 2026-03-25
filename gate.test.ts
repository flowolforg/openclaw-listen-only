import { describe, it, expect, beforeEach } from "vitest";
import { evaluateGate } from "./gate.js";
import { clearAllRateLimits } from "./rate-limit.js";
import type { ListenOnlyConfig } from "./types.js";

const baseConfig: ListenOnlyConfig = {
  enabled: true,
  triggers: ["mention"],
  rateLimit: { maxRepliesPerWindow: 10, windowSeconds: 60 },
  onlyHumanTriggers: true,
};

beforeEach(() => {
  clearAllRateLimits();
});

describe("evaluateGate", () => {
  it("returns passthrough when not a group", () => {
    const result = evaluateGate({ config: baseConfig, isGroup: false, content: "hello" });
    expect(result).toEqual({ action: "passthrough" });
  });

  it("returns passthrough when disabled", () => {
    const result = evaluateGate({
      config: { ...baseConfig, enabled: false },
      isGroup: true,
      content: "hello",
    });
    expect(result).toEqual({ action: "passthrough" });
  });

  it("returns passthrough when forceOff", () => {
    const result = evaluateGate({
      config: { ...baseConfig, forceOff: true },
      isGroup: true,
      content: "hello",
    });
    expect(result).toEqual({ action: "passthrough" });
  });

  it("returns listen for self messages", () => {
    const result = evaluateGate({
      config: baseConfig,
      isGroup: true,
      senderId: "bot123",
      selfBotId: "bot123",
      content: "hello",
    });
    expect(result).toEqual({ action: "listen", reason: "self_message" });
  });

  it("returns listen for known bot IDs", () => {
    const result = evaluateGate({
      config: { ...baseConfig, ignoreKnownBotIds: ["bot456"] },
      isGroup: true,
      senderId: "bot456",
      content: "hello",
    });
    expect(result).toEqual({ action: "listen", reason: "known_bot:bot456" });
  });

  it("returns listen for bot senders when onlyHumanTriggers", () => {
    const result = evaluateGate({
      config: baseConfig,
      isGroup: true,
      senderIsBot: true,
      content: "hello",
    });
    expect(result).toEqual({ action: "listen", reason: "bot_sender" });
  });

  it("returns trigger on mention", () => {
    const result = evaluateGate({
      config: baseConfig,
      isGroup: true,
      wasMentioned: true,
      sessionKey: "sess1",
      content: "hello @bot",
    });
    expect(result).toEqual({ action: "trigger", reason: "mention" });
  });

  it("returns listen when no trigger matches", () => {
    const result = evaluateGate({
      config: baseConfig,
      isGroup: true,
      wasMentioned: false,
      content: "just chatting",
    });
    expect(result).toEqual({ action: "listen", reason: "no_trigger" });
  });

  it("returns trigger on explicit command", () => {
    const result = evaluateGate({
      config: { ...baseConfig, triggers: ["explicit_command"] },
      isGroup: true,
      sessionKey: "sess1",
      content: "!search something",
    });
    expect(result).toEqual({ action: "trigger", reason: "explicit_command" });
  });

  it("returns trigger on owner voice", () => {
    const result = evaluateGate({
      config: { ...baseConfig, triggers: ["owner_voice"] },
      isGroup: true,
      senderId: "owner1",
      sessionKey: "sess1",
      content: "[audio]",
      mediaTypes: ["audio/ogg"],
      ownerAllowFrom: ["owner1"],
    });
    expect(result).toEqual({ action: "trigger", reason: "owner_voice" });
  });

  it("returns trigger on owner image", () => {
    const result = evaluateGate({
      config: { ...baseConfig, triggers: ["owner_image"] },
      isGroup: true,
      senderId: "owner1",
      sessionKey: "sess1",
      content: "[image]",
      mediaTypes: ["image/jpeg"],
      ownerAllowFrom: ["owner1"],
    });
    expect(result).toEqual({ action: "trigger", reason: "owner_image" });
  });

  it("rate-limits trigger when window exhausted", () => {
    const config: ListenOnlyConfig = {
      ...baseConfig,
      rateLimit: { maxRepliesPerWindow: 2, windowSeconds: 60 },
    };

    // First two triggers succeed
    expect(
      evaluateGate({ config, isGroup: true, wasMentioned: true, sessionKey: "s1", content: "1" }),
    ).toEqual({ action: "trigger", reason: "mention" });
    expect(
      evaluateGate({ config, isGroup: true, wasMentioned: true, sessionKey: "s1", content: "2" }),
    ).toEqual({ action: "trigger", reason: "mention" });

    // Third is rate-limited
    expect(
      evaluateGate({ config, isGroup: true, wasMentioned: true, sessionKey: "s1", content: "3" }),
    ).toEqual({ action: "listen", reason: "rate_limited" });
  });

  it("returns trigger on text-based mention (Matrix/IRC)", () => {
    const result = evaluateGate({
      config: baseConfig,
      isGroup: true,
      wasMentioned: false,
      sessionKey: "sess1",
      content: "hey @mybot can you help?",
      selfBotNames: ["mybot"],
    });
    expect(result).toEqual({ action: "trigger", reason: "mention" });
  });

  it("returns trigger on Matrix-style mention (@user:server)", () => {
    const result = evaluateGate({
      config: baseConfig,
      isGroup: true,
      wasMentioned: false,
      sessionKey: "sess1",
      content: "hello @bot:matrix.org what do you think?",
      selfBotNames: ["bot:matrix.org"],
    });
    expect(result).toEqual({ action: "trigger", reason: "mention" });
  });

  it("returns listen when text mention does not match", () => {
    const result = evaluateGate({
      config: baseConfig,
      isGroup: true,
      wasMentioned: false,
      content: "hey @otherbot can you help?",
      selfBotNames: ["mybot"],
    });
    expect(result).toEqual({ action: "listen", reason: "no_trigger" });
  });

  it("rate-limits per topic in forum groups", () => {
    const config: ListenOnlyConfig = {
      ...baseConfig,
      rateLimit: { maxRepliesPerWindow: 1, windowSeconds: 60 },
    };

    // Topic A: first mention triggers
    expect(
      evaluateGate({
        config,
        isGroup: true,
        wasMentioned: true,
        sessionKey: "-100123:topic:42",
        content: "a",
      }),
    ).toEqual({ action: "trigger", reason: "mention" });

    // Topic A: second mention is rate-limited
    expect(
      evaluateGate({
        config,
        isGroup: true,
        wasMentioned: true,
        sessionKey: "-100123:topic:42",
        content: "b",
      }),
    ).toEqual({ action: "listen", reason: "rate_limited" });

    // Topic B: same group but different topic — should trigger independently
    expect(
      evaluateGate({
        config,
        isGroup: true,
        wasMentioned: true,
        sessionKey: "-100123:topic:99",
        content: "c",
      }),
    ).toEqual({ action: "trigger", reason: "mention" });
  });
});
