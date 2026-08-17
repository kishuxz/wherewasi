import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_DEFAULT_MODEL,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  isLocalEndpoint,
  selectProvider,
} from "../src/providers/index.js";

describe("provider selection", () => {
  it("defaults to the OpenAI-compatible client pointed at Groq", () => {
    const { provider } = selectProvider({ WHEREWASI_API_KEY: "sk-x" });
    expect(provider?.name).toBe("openai-compatible");
    expect(provider?.model).toBe(DEFAULT_MODEL);
  });

  it("routes any OpenAI-compatible vendor through one path", () => {
    for (const baseUrl of [
      "https://api.openai.com/v1",
      "https://api.together.xyz/v1",
      "https://openrouter.ai/api/v1",
      "https://api.deepseek.com/v1",
    ]) {
      const { provider } = selectProvider({
        WHEREWASI_API_KEY: "sk-x",
        WHEREWASI_BASE_URL: baseUrl,
        WHEREWASI_MODEL: "some-model",
      });
      expect(provider?.name).toBe("openai-compatible");
      expect(provider?.model).toBe("some-model");
    }
  });

  it("selects Anthropic from the base URL alone", () => {
    const { provider } = selectProvider({
      WHEREWASI_API_KEY: "sk-ant-x",
      WHEREWASI_BASE_URL: "https://api.anthropic.com",
    });
    expect(provider?.name).toBe("anthropic");
    expect(provider?.model).toBe(ANTHROPIC_DEFAULT_MODEL);
  });

  it("selects Anthropic from WHEREWASI_PROVIDER", () => {
    const { provider } = selectProvider({
      WHEREWASI_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "sk-ant-x",
    });
    expect(provider?.name).toBe("anthropic");
  });

  it("keeps the OpenAI-compatible path when a provider is named explicitly", () => {
    const { provider } = selectProvider({
      WHEREWASI_PROVIDER: "openai",
      WHEREWASI_API_KEY: "sk-x",
      ANTHROPIC_API_KEY: "sk-ant-y",
    });
    expect(provider?.name).toBe("openai-compatible");
  });

  it("needs no API key for a local endpoint", () => {
    for (const baseUrl of ["http://localhost:11434/v1", "http://127.0.0.1:11434/v1"]) {
      const { provider, reason } = selectProvider({
        WHEREWASI_BASE_URL: baseUrl,
        WHEREWASI_MODEL: "qwen2.5-coder",
      });
      expect(reason).toBeNull();
      expect(provider?.name).toBe("openai-compatible");
      expect(provider?.model).toBe("qwen2.5-coder");
    }
  });

  it("identifies local endpoints and only local endpoints", () => {
    expect(isLocalEndpoint("http://localhost:11434/v1")).toBe(true);
    expect(isLocalEndpoint("http://127.0.0.1:1234/v1")).toBe(true);
    expect(isLocalEndpoint(DEFAULT_BASE_URL)).toBe(false);
    expect(isLocalEndpoint("https://api.openai.com/v1")).toBe(false);
  });

  describe("legacy environment variables", () => {
    it("still accepts GROQ_API_KEY", () => {
      const { provider } = selectProvider({ GROQ_API_KEY: "gsk_x" });
      expect(provider?.name).toBe("openai-compatible");
    });

    it("still accepts ANTHROPIC_API_KEY alone", () => {
      const { provider } = selectProvider({ ANTHROPIC_API_KEY: "sk-ant-y" });
      expect(provider?.name).toBe("anthropic");
    });

    it("prefers the OpenAI-compatible path when both legacy keys are set", () => {
      const { provider } = selectProvider({ GROQ_API_KEY: "gsk_x", ANTHROPIC_API_KEY: "sk-ant-y" });
      expect(provider?.name).toBe("openai-compatible");
    });

    it("lets the new key win over the legacy one", () => {
      const { provider } = selectProvider({ WHEREWASI_API_KEY: "sk-new", GROQ_API_KEY: "gsk_old" });
      expect(provider?.name).toBe("openai-compatible");
    });

    it("still accepts GROQ_MODEL as a model override", () => {
      const { provider } = selectProvider({
        GROQ_API_KEY: "gsk_x",
        GROQ_MODEL: "llama-3.1-8b-instant",
      });
      expect(provider?.model).toBe("llama-3.1-8b-instant");
    });
  });

  describe("no usable configuration", () => {
    it("reports a missing key for a remote endpoint", () => {
      const { provider, reason } = selectProvider({});
      expect(provider).toBeNull();
      expect(reason).toMatch(/WHEREWASI_API_KEY/);
    });

    it("reports a missing key when Anthropic is requested without one", () => {
      const { provider, reason } = selectProvider({
        WHEREWASI_PROVIDER: "anthropic",
        GROQ_API_KEY: "gsk_x",
      });
      expect(provider).toBeNull();
      expect(reason).toMatch(/ANTHROPIC_API_KEY/);
    });
  });
});
