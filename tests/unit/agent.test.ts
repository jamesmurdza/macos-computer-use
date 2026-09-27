import { describe, expect, it } from "vitest";
import { AGENT_SYSTEM_PROMPT, buildSystemPrompt, MAX_AGENT_STEPS } from "../../src/lib/agent.js";

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
