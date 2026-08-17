import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_DEFAULT_MODEL,
  GROQ_DEFAULT_MODEL,
  selectProvider,
} from "../src/providers/index.js";

describe("provider selection", () => {
  it("defaults to Groq when only GROQ_API_KEY is set", () => {
    const { provider } = selectProvider({ GROQ_API_KEY: "gsk_x" });
    expect(provider?.name).toBe("groq");
    expect(provider?.model).toBe(GROQ_DEFAULT_MODEL);
  });

  it("prefers Groq when both keys are set", () => {
    const { provider } = selectProvider({ GROQ_API_KEY: "gsk_x", ANTHROPIC_API_KEY: "sk-ant-y" });
    expect(provider?.name).toBe("groq");
  });

  it("falls back to Anthropic when it is the only key", () => {
    const { provider } = selectProvider({ ANTHROPIC_API_KEY: "sk-ant-y" });
    expect(provider?.name).toBe("anthropic");
    expect(provider?.model).toBe(ANTHROPIC_DEFAULT_MODEL);
  });

  it("honours WHEREWASI_PROVIDER=anthropic even when a Groq key is present", () => {
    const { provider } = selectProvider({
      GROQ_API_KEY: "gsk_x",
      ANTHROPIC_API_KEY: "sk-ant-y",
      WHEREWASI_PROVIDER: "anthropic",
    });
    expect(provider?.name).toBe("anthropic");
  });

  it("honours WHEREWASI_PROVIDER=groq even when Anthropic would otherwise win", () => {
    const { provider } = selectProvider({
      GROQ_API_KEY: "gsk_x",
      ANTHROPIC_API_KEY: "sk-ant-y",
      WHEREWASI_PROVIDER: "groq",
    });
    expect(provider?.name).toBe("groq");
  });

  it("reports the mismatch when the requested provider has no key", () => {
    const anthropic = selectProvider({ GROQ_API_KEY: "gsk_x", WHEREWASI_PROVIDER: "anthropic" });
    expect(anthropic.provider).toBeNull();
    expect(anthropic.reason).toMatch(/ANTHROPIC_API_KEY/);

    const groq = selectProvider({ ANTHROPIC_API_KEY: "sk-ant-y", WHEREWASI_PROVIDER: "groq" });
    expect(groq.provider).toBeNull();
    expect(groq.reason).toMatch(/GROQ_API_KEY/);
  });

  it("ignores an unrecognised WHEREWASI_PROVIDER and uses the key precedence", () => {
    const { provider } = selectProvider({ GROQ_API_KEY: "gsk_x", WHEREWASI_PROVIDER: "openai" });
    expect(provider?.name).toBe("groq");
  });

  it("returns a reason, not a provider, when no key is set", () => {
    const { provider, reason } = selectProvider({});
    expect(provider).toBeNull();
    expect(reason).toMatch(/GROQ_API_KEY or ANTHROPIC_API_KEY/);
  });

  it("allows the model to be overridden without a code change", () => {
    const { provider } = selectProvider({
      GROQ_API_KEY: "gsk_x",
      GROQ_MODEL: "llama-3.1-8b-instant",
    });
    expect(provider?.model).toBe("llama-3.1-8b-instant");
  });
});
