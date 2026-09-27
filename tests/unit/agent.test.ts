import { describe, expect, it } from "vitest";
import { AGENT_SYSTEM_PROMPT, agentRequest, buildSystemPrompt, MAX_AGENT_STEPS } from "../../src/lib/agent.js";

describe("AGENT_SYSTEM_PROMPT", () => {
  it("names the tools and steers toward the GUI ones", () => {
    expect(AGENT_SYSTEM_PROMPT).toMatch(/read_accessibility_tree/);
    expect(AGENT_SYSTEM_PROMPT).toMatch(/open_app/);
    expect(AGENT_SYSTEM_PROMPT).toMatch(/click_element/);
    expect(AGENT_SYSTEM_PROMPT).toMatch(/type_text/);
    expect(AGENT_SYSTEM_PROMPT).toMatch(/press_keys/);
  });
});

describe("buildSystemPrompt", () => {
  it("includes the real current date/time, not just the static prompt", () => {
    // Regression: a real run needed "today's date" for a task and had no way to get it -- the
    // menu-bar clock visible on screen shows the day of week and time but never the year, so the
    // model guessed from its own training data and wrote the wrong year into a document.
    const prompt = buildSystemPrompt(new Date("2026-09-27T14:30:00Z"));
    expect(prompt).toContain(AGENT_SYSTEM_PROMPT);
    expect(prompt).toMatch(/2026/);
    expect(prompt).toMatch(/Sep/);
  });

  it("defaults to the real current time when no date is given", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain(String(new Date().getFullYear()));
  });
});

describe("MAX_AGENT_STEPS", () => {
  it("is a sane positive bound", () => {
    expect(MAX_AGENT_STEPS).toBeGreaterThan(1);
    expect(MAX_AGENT_STEPS).toBeLessThanOrEqual(80);
  });
});

describe("agentRequest maxSteps", () => {
  // Regression: tools/agent-run.ts needs to run deliberately long, multi-app headless demos
  // (e.g. MAX_STEPS=150) without changing the web app's default 40-step budget. `stopWhen` is an
  // opaque predicate from the AI SDK's stepCountIs(), so we drive it directly with fake step
  // arrays rather than trying to inspect it structurally.
  // Only stopWhen is under test here; the tools map's shape is irrelevant to it.
  const noTools = {} as Parameters<typeof agentRequest>[2];

  it("stops at the caller-supplied maxSteps, not the global default", () => {
    const { stopWhen } = agentRequest([], "openrouter:qwen/qwen3.7-flash", noTools, 150);
    expect(stopWhen({ steps: new Array(150) })).toBe(true);
    expect(stopWhen({ steps: new Array(40) })).toBe(false);
  });

  it("still honors MAX_AGENT_STEPS when the caller passes it explicitly", () => {
    const { stopWhen } = agentRequest([], "openrouter:qwen/qwen3.7-flash", noTools, MAX_AGENT_STEPS);
    expect(stopWhen({ steps: new Array(MAX_AGENT_STEPS) })).toBe(true);
  });
});
