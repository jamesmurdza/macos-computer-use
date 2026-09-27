import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { estimateCost, getModelPricing } from "../../src/lib/cost.js";

describe("getModelPricing", () => {
  it("returns hardcoded Anthropic pricing for haiku/sonnet/opus, no network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await getModelPricing("haiku")).toEqual({ inputPerMillion: 1, outputPerMillion: 5 });
    expect(await getModelPricing("sonnet")).toEqual({ inputPerMillion: 2, outputPerMillion: 10 });
    expect(await getModelPricing("opus")).toEqual({ inputPerMillion: 5, outputPerMillion: 25 });
    expect(fetchMock).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  describe("openrouter: selectors", () => {
    const fetchMock = vi.fn();
    beforeEach(() => vi.stubGlobal("fetch", fetchMock));
    afterEach(() => {
      vi.unstubAllGlobals();
      fetchMock.mockReset();
    });

    it("fetches OpenRouter's public model list and converts per-token price to per-million", async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ id: "qwen/qwen3.7-flash", pricing: { prompt: "0.00000003", completion: "0.00000013" } }] }),
      });

      const pricing = await getModelPricing("openrouter:qwen/qwen3.7-flash");

      expect(fetchMock).toHaveBeenCalledWith("https://openrouter.ai/api/v1/models");
      expect(pricing?.inputPerMillion).toBeCloseTo(0.03, 6);
      expect(pricing?.outputPerMillion).toBeCloseTo(0.13, 6);
    });

    it("returns undefined when the model isn't in the list", async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
      expect(await getModelPricing("openrouter:nonexistent/model")).toBeUndefined();
    });

    it("returns undefined on a network/HTTP error rather than throwing", async () => {
      fetchMock.mockResolvedValue({ ok: false });
      expect(await getModelPricing("openrouter:qwen/qwen3.7-flash")).toBeUndefined();

      fetchMock.mockRejectedValue(new Error("network down"));
      expect(await getModelPricing("openrouter:qwen/qwen3.7-flash")).toBeUndefined();
    });
  });
});

describe("estimateCost", () => {
  const pricing = { inputPerMillion: 2, outputPerMillion: 10 };

  it("computes cost from input and output token counts", () => {
    expect(estimateCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, pricing)).toBe(12);
    expect(estimateCost({ inputTokens: 500_000, outputTokens: 100_000 }, pricing)).toBeCloseTo(2, 6);
  });

  it("treats missing token counts as zero", () => {
    expect(estimateCost({}, pricing)).toBe(0);
    expect(estimateCost({ inputTokens: 1_000_000 }, pricing)).toBe(2);
  });
});
