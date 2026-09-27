import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_CHOICE,
  isModelChoice,
  isModelSelector,
  isOpenRouterSelector,
  MODEL_IDS,
  openRouterModelId,
} from "../../src/lib/llm.js";

describe("model choices", () => {
  it("maps every choice to a claude-* model id", () => {
    for (const id of Object.values(MODEL_IDS)) expect(id).toMatch(/^claude-/);
  });

  it("defaults to a valid choice", () => {
    expect(isModelChoice(DEFAULT_MODEL_CHOICE)).toBe(true);
  });

  it("accepts only the three known choices", () => {
    expect(isModelChoice("opus")).toBe(true);
    expect(isModelChoice("sonnet")).toBe(true);
    expect(isModelChoice("haiku")).toBe(true);
    expect(isModelChoice("gpt")).toBe(false);
    expect(isModelChoice(undefined)).toBe(false);
  });
});

describe("OpenRouter model selectors (tools/agent-run.ts only -- the web app never produces these)", () => {
  it("isOpenRouterSelector recognizes the openrouter: prefix", () => {
    expect(isOpenRouterSelector("openrouter:qwen/qwen3.7-flash")).toBe(true);
    expect(isOpenRouterSelector("haiku")).toBe(false);
    expect(isOpenRouterSelector("openrouter:")).toBe(true); // empty model id -- caught elsewhere, not this check's job
  });

  it("openRouterModelId strips the prefix to get the bare provider/model-id", () => {
    expect(openRouterModelId("openrouter:qwen/qwen3.7-flash")).toBe("qwen/qwen3.7-flash");
    expect(openRouterModelId("openrouter:deepseek/deepseek-v4-flash")).toBe("deepseek/deepseek-v4-flash");
  });

  it("isModelSelector accepts both ModelChoice and openrouter: strings, rejects everything else", () => {
    expect(isModelSelector("haiku")).toBe(true);
    expect(isModelSelector("openrouter:qwen/qwen3.7-flash")).toBe(true);
    expect(isModelSelector("gpt-4")).toBe(false);
    expect(isModelSelector(undefined)).toBe(false);
    expect(isModelSelector(42)).toBe(false);
  });
});
