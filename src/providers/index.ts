import { ANTHROPIC_DEFAULT_MODEL, AnthropicProvider } from "./anthropic.js";
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  OpenAICompatibleProvider,
  isLocalEndpoint,
} from "./openai-compatible.js";
import type { Provider } from "./types.js";

export * from "./types.js";
export {
  OpenAICompatibleProvider,
  DEFAULT_MODEL,
  DEFAULT_BASE_URL,
  isLocalEndpoint,
} from "./openai-compatible.js";
export { AnthropicProvider, ANTHROPIC_DEFAULT_MODEL } from "./anthropic.js";

export type ProviderEnv = Record<string, string | undefined>;

export interface Selection {
  provider: Provider | null;
  /** Populated when no provider could be built; shown to the user verbatim. */
  reason: string | null;
}

const ANTHROPIC_HOST = "api.anthropic.com";

function usesAnthropic(env: ProviderEnv): boolean {
  const explicit = env["WHEREWASI_PROVIDER"]?.trim().toLowerCase();
  if (explicit === "anthropic") return true;
  if (explicit === "openai" || explicit === "openai-compatible" || explicit === "groq") {
    return false;
  }
  const baseUrl = env["WHEREWASI_BASE_URL"]?.trim();
  if (baseUrl?.includes(ANTHROPIC_HOST)) return true;
  // Legacy: an Anthropic key with no OpenAI-compatible key selects Anthropic.
  if (!baseUrl && !env["WHEREWASI_API_KEY"] && !env["GROQ_API_KEY"] && env["ANTHROPIC_API_KEY"]) {
    return true;
  }
  return false;
}

/**
 * The model is resolved to a real name here rather than left as "" for the
 * provider constructor to rescue. The empty string never reached the wire —
 * the constructor substituted a default — but it meant the choice was made two
 * layers from where it was configured and was never reported, so two full
 * evaluation runs completed against a model nobody had recorded.
 *
 * One OpenAI-compatible path covers Groq, OpenAI, Together, OpenRouter,
 * DeepSeek and a local Ollama — they differ only by base URL and model id.
 * Anthropic is the one genuine exception, since its wire format differs.
 */
export function selectProvider(env: ProviderEnv = process.env): Selection {
  if (usesAnthropic(env)) {
    const key = env["WHEREWASI_API_KEY"]?.trim() || env["ANTHROPIC_API_KEY"]?.trim();
    if (!key) {
      return {
        provider: null,
        reason: "Anthropic selected but neither WHEREWASI_API_KEY nor ANTHROPIC_API_KEY is set",
      };
    }
    return {
      provider: new AnthropicProvider({
        apiKey: key,
        model:
          env["WHEREWASI_MODEL"]?.trim() ||
          env["ANTHROPIC_MODEL"]?.trim() ||
          ANTHROPIC_DEFAULT_MODEL,
      }),
      reason: null,
    };
  }

  const baseUrl =
    env["WHEREWASI_BASE_URL"]?.trim() || env["GROQ_BASE_URL"]?.trim() || DEFAULT_BASE_URL;
  const key = env["WHEREWASI_API_KEY"]?.trim() || env["GROQ_API_KEY"]?.trim();

  // A local endpoint needs no credential, which is the point of running one.
  if (!key && !isLocalEndpoint(baseUrl)) {
    return {
      provider: null,
      reason: "no API key set (WHEREWASI_API_KEY, or GROQ_API_KEY for the default endpoint)",
    };
  }

  return {
    provider: new OpenAICompatibleProvider({
      apiKey: key ?? "",
      model: env["WHEREWASI_MODEL"]?.trim() || env["GROQ_MODEL"]?.trim() || DEFAULT_MODEL,
      baseUrl,
    }),
    reason: null,
  };
}
