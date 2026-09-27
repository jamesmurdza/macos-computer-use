import { isModelChoice, isOpenRouterSelector, openRouterModelId, type ModelSelector } from "./llm";

export interface ModelPricing {
  /** USD per 1M input (prompt) tokens. */
  inputPerMillion: number;
  /** USD per 1M output (completion) tokens. */
  outputPerMillion: number;
}

/**
 * Anthropic has no public unauthenticated pricing API (unlike OpenRouter, below), so these are
 * hardcoded -- cross-checked against OpenRouter's own live pricing for the same three models on
 * 2026-09-27 (which passes through vendor prices with no markup), not just quoted from memory.
 * Update if Anthropic changes list pricing.
 */
const ANTHROPIC_PRICING: Record<"opus" | "sonnet" | "haiku", ModelPricing> = {
  opus: { inputPerMillion: 5, outputPerMillion: 25 },
  sonnet: { inputPerMillion: 2, outputPerMillion: 10 },
  haiku: { inputPerMillion: 1, outputPerMillion: 5 },
};

interface OpenRouterModelsResponse {
  data?: Array<{ id: string; pricing?: { prompt?: string; completion?: string } }>;
}

/**
 * Current pricing for `modelChoice`, or undefined if it can't be determined (an OpenRouter model
 * id that doesn't exist / a network error looking it up) -- callers should treat that as "cost
 * unknown for this run" rather than fail the whole run over a pricing lookup.
 *
 * For `openrouter:...` selectors, this hits OpenRouter's public, unauthenticated
 * `GET /api/v1/models` (verified directly: no API key needed, confirmed with a bare `curl`) and
 * reads that model's current listed price -- live, not a hardcoded table that could drift from
 * what OpenRouter actually charges as they add/reprice models.
 */
export async function getModelPricing(modelChoice: ModelSelector): Promise<ModelPricing | undefined> {
  if (isModelChoice(modelChoice)) return ANTHROPIC_PRICING[modelChoice];

  if (isOpenRouterSelector(modelChoice)) {
    const id = openRouterModelId(modelChoice);
    try {
      const res = await fetch("https://openrouter.ai/api/v1/models");
      if (!res.ok) return undefined;
      const body = (await res.json()) as OpenRouterModelsResponse;
      const model = body.data?.find((m) => m.id === id);
      if (!model?.pricing) return undefined;
      // OpenRouter quotes price per single token (e.g. "0.00000005"); convert to per-million.
      const promptPrice = Number(model.pricing.prompt);
      const completionPrice = Number(model.pricing.completion);
      if (!Number.isFinite(promptPrice) || !Number.isFinite(completionPrice)) return undefined;
      return { inputPerMillion: promptPrice * 1e6, outputPerMillion: completionPrice * 1e6 };
    } catch {
      return undefined;
    }
  }

  return undefined;
}

/** Estimated USD cost from token counts and a pricing table -- an estimate against current list
 * price, not the exact amount actually billed (which could differ slightly with prompt caching,
 * volume discounts, etc.). Missing token counts are treated as zero for that side. */
export function estimateCost(usage: { inputTokens?: number; outputTokens?: number }, pricing: ModelPricing): number {
  const input = (usage.inputTokens ?? 0) / 1e6 * pricing.inputPerMillion;
  const output = (usage.outputTokens ?? 0) / 1e6 * pricing.outputPerMillion;
  return input + output;
}
