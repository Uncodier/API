import { composeVoiceSystemPrompt, fitZavuSystemPrompt } from "../voice-prompt-budget";

function compose(background: string, runtime = "Voice runtime rules") {
  return composeVoiceSystemPrompt({
    runtime,
    background,
    reminder: "Never invent results.",
    timezone: "UTC",
  });
}

it("keeps complete short sections without an omission warning", () => {
  const background = "# Site Information\n## Site Details\nExample business\n\n## Team Members\nMorgan";
  const prompt = compose(background);

  expect(prompt).toContain("## Site Details\nExample business");
  expect(prompt).toContain("## Team Members\nMorgan");
  expect(prompt).not.toContain("omitted");
});

it("does not interpret markdown inside reference-file fences as background sections", () => {
  const prompt = compose([
    "# Current Date & Time\nServer UTC: stale sync time",
    "# Instructions\n1. Respond helpfully to user requests.\nWorkflow-only instruction",
    "## Reference Files\n### policy.md\n```markdown\n# Instructions\nUse approved parts.\n```",
  ].join("\n\n"));

  expect(prompt).not.toContain("stale sync time");
  expect(prompt).not.toContain("Workflow-only instruction");
  expect(prompt).toContain("# Instructions\nUse approved parts.");
});

it("preserves title-only campaigns and custom instruction headings", () => {
  const prompt = compose([
    "# Instructions\n1. Respond helpfully to user requests.\nGeneric workflow rules",
    "# Agent Custom Instructions\n# Instructions\nConfirm the repair model.",
    "# Active Campaigns\nCurrent offers:",
    "## Campaign 1: Autumn maintenance",
  ].join("\n\n"));

  expect(prompt).not.toContain("Generic workflow rules");
  expect(prompt).toContain("Confirm the repair model.");
  expect(prompt).toContain("## Campaign 1: Autumn maintenance");
});

it.each([500, 5_000, 50_000, 100_000])(
  "retains core sections and required rules with %i characters in each long section",
  (length) => {
    const background = [
      `# Backstory\n${"b".repeat(length)}`,
      `## Copywriting Content\n${"c".repeat(length)}`,
      `## Reference Files\n${"r".repeat(length)}`,
      "## Site Details\nExample business",
      "## Team Members\nMorgan manages repairs",
      "## Business Hours\nMonday 09:00-18:00",
      "## Services\nWheel alignment",
      "## Campaign 1: Seasonal tune-up\nAutumn maintenance",
    ].join("\n\n");
    const runtime = "Mandatory voice rules. ".repeat(250);
    const prompt = compose(background, runtime);

    for (const fact of [
      "Example business", "Morgan manages repairs", "Monday 09:00-18:00",
      "Wheel alignment", "Autumn maintenance",
    ]) expect(prompt).toContain(fact);
    expect(prompt.startsWith(runtime)).toBe(true);
    expect(prompt.endsWith("Never invent results.")).toBe(true);
    expect(prompt.length).toBeLessThanOrEqual(10_000);
  }
);

it("prioritizes core facts if an excessive number of optional sections cannot fit", () => {
  const background = Array.from({ length: 200 }, (_, index) =>
    `## Campaign ${index}\n${"Campaign description. ".repeat(20)}`
  ).join("\n\n") + "\n\n## Site Details\nExample business\n\n## Team Members\nMorgan";
  const prompt = compose(background);

  expect(prompt).toContain("Example business");
  expect(prompt).toContain("Morgan");
  expect(prompt).toContain("Additional business context omitted");
  expect(prompt.length).toBeLessThanOrEqual(10_000);
});

it("rejects oversized runtime instructions instead of syncing a tools-only agent", () => {
  expect(() => compose("## Site Details\nExample business", "r".repeat(9_000)))
    .toThrow("insufficient room for business context");
  expect(() => fitZavuSystemPrompt("business", "r".repeat(10_000)))
    .toThrow("Voice runtime rules exceed");
});

it("reserves a business brief in full under worst-case optional context pressure", () => {
  const businessBrief = ("# Business Identity and Offerings\n" + "Business fact. ".repeat(100)).trim();
  const prompt = composeVoiceSystemPrompt({
    runtime: "r".repeat(5_599),
    background: Array.from({ length: 80 }, (_, i) => `## Campaign ${i}\n${"Long copy. ".repeat(100)}`).join("\n\n"),
    reminder: "Never invent results.", timezone: "UTC", businessBrief,
  });
  expect(prompt).toContain(businessBrief);
  expect(prompt.length).toBeLessThanOrEqual(10_000);
  expect(() => composeVoiceSystemPrompt({ runtime: "Rules", background: "Facts", reminder: "Safety", timezone: "UTC", businessBrief: "x".repeat(1_601) }))
    .toThrow("Voice business brief exceeds");
});