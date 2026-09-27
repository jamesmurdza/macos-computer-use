/** The model choices exposed in the web UI's dropdown -- unchanged by OpenRouter support below;
 * the web app only ever produces/validates these three, straight to Anthropic. */
export type ModelChoice = "opus" | "sonnet" | "haiku";

export const MODEL_IDS: Record<ModelChoice, string> = {
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5",
};

export const DEFAULT_MODEL_CHOICE: ModelChoice = "haiku";

export function isModelChoice(value: unknown): value is ModelChoice {
  return value === "opus" || value === "sonnet" || value === "haiku";
}

const OPENROUTER_PREFIX = "openrouter:";

/**
 * `tools/agent-run.ts`-only: a broader selector than the web app's `ModelChoice` that additionally
 * accepts `openrouter:<provider>/<model-id>` (e.g. `openrouter:qwen/qwen3.7-flash`), for
 * experimenting with cheaper/alternative models via OpenRouter without touching the web app's
 * fixed three-model dropdown. `ModelChoice` is a subset of this, so every existing caller that
 * only ever produces a `ModelChoice` keeps working unchanged.
 */
export type ModelSelector = ModelChoice | `${typeof OPENROUTER_PREFIX}${string}`;

export function isOpenRouterSelector(value: string): value is `${typeof OPENROUTER_PREFIX}${string}` {
  return value.startsWith(OPENROUTER_PREFIX);
}

/** The bare `provider/model-id` OpenRouter expects, with the `openrouter:` prefix stripped. */
export function openRouterModelId(selector: `${typeof OPENROUTER_PREFIX}${string}`): string {
  return selector.slice(OPENROUTER_PREFIX.length);
}

/** Accepts a `ModelChoice` (`"haiku"`/`"sonnet"`/`"opus"`) or an `openrouter:...` string --
 * `tools/agent-run.ts`'s `MODEL` env var parsing. */
export function isModelSelector(value: unknown): value is ModelSelector {
  return isModelChoice(value) || (typeof value === "string" && isOpenRouterSelector(value));
}
