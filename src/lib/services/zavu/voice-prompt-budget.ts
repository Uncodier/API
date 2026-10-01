import { MAX_VOICE_BUSINESS_BRIEF_LENGTH } from "./voice-business-brief";

export const MAX_SYSTEM_PROMPT_LENGTH = 10_000;
const OMISSION = "\n\n[Additional business context omitted due to provider limits.]";
const EXCERPT = "… [excerpt]";
const MIN_SECTION_BODY_LENGTH = 80;

type Section = { heading: string; body: string };

const CORE_SECTIONS = new Set([
  "Business Timezone", "Agent Identity", "System Instructions", "Agent Custom Instructions",
  "Site Details", "Site Configuration", "Business Model", "Products", "Services",
  "Business Hours", "Locations", "Team Members", "Team Roles",
  "Organizational Structure", "Communication Channels", "Brand Identity",
]);

/** Split the shared builder's sections without interpreting headings in file code fences. */
function splitSections(prompt: string): Section[] {
  const sections: Section[] = [];
  let current: Section = { heading: "", body: "" };
  let fence: string | undefined;
  for (const line of prompt.split("\n")) {
    const delimiter = line.match(/^\s*(`{3,}|~{3,})/);
    if (delimiter) {
      if (!fence) fence = delimiter[1];
      else if (delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length) {
        fence = undefined;
      }
    }
    if (!fence && /^#{1,2} /.test(line)) {
      if (current.heading || current.body.trim()) sections.push(current);
      current = { heading: line, body: "" };
    } else {
      current.body += `${line}\n`;
    }
  }
  if (current.heading || current.body.trim()) sections.push(current);
  return sections.map(({ heading, body }) => ({ heading, body: body.trim() }));
}

function title(section: Section): string {
  return section.heading.replace(/^#+ /, "");
}

function render(section: Section): string {
  return [section.heading, section.body].filter(Boolean).join("\n");
}

function priority(section: Section): number {
  return CORE_SECTIONS.has(title(section)) ? 3 : 1;
}

/** Weighted, redistributable budgets keep long copy/files from starving later sections. */
function allocate(lengths: number[], weights: number[], available: number): number[] {
  const budgets = lengths.map(() => 0);
  while (available > 0) {
    const pending = lengths.map((_, index) => index)
      .filter((index) => budgets[index] < lengths[index]);
    if (!pending.length) break;
    const totalWeight = pending.reduce((total, index) => total + weights[index], 0);
    const roundBudget = available;
    for (const index of pending) {
      const share = Math.min(
        lengths[index] - budgets[index], available,
        Math.max(1, Math.floor(roundBudget * weights[index] / totalWeight))
      );
      budgets[index] += share;
      available -= share;
    }
  }
  return budgets;
}

function excerpt(text: string, budget: number): string {
  if (text.length <= budget) return text;
  return `${text.slice(0, Math.max(0, budget - EXCERPT.length)).trimEnd()}${EXCERPT}`;
}

function fitBackground(sections: Section[], available: number): string {
  const complete = sections.map(render).join("\n\n");
  if (complete.length <= available) return complete;
  // Core facts get first claim when even section labels cannot all fit.
  const ordered = sections.map((section, index) => ({ section, index }))
    .sort((a, b) => priority(b.section) - priority(a.section) || a.index - b.index);
  const selected: Section[] = [];
  let remaining = available - OMISSION.length;
  for (const { section } of ordered) {
    const minimum = section.heading.length + 1
      + Math.min(section.body.length, MIN_SECTION_BODY_LENGTH);
    const separator = selected.length ? 2 : 0;
    if (minimum + separator <= remaining) {
      selected.push(section);
      remaining -= minimum + separator;
    }
  }
  const budgets = allocate(
    selected.map((section) => Math.max(0, section.body.length - MIN_SECTION_BODY_LENGTH)),
    selected.map(priority), remaining
  );
  const content = selected.map((section, index) => {
    const budget = Math.min(section.body.length, MIN_SECTION_BODY_LENGTH) + budgets[index];
    return render({ ...section, body: excerpt(section.body, budget) });
  }).join("\n\n");
  if (content.length + OMISSION.length > available) {
    throw new Error("Voice background exceeds its reserved prompt budget");
  }
  return `${content}${OMISSION}`;
}

/** Compatibility helper for unstructured prompts; required rules are never sliced. */
export function fitZavuSystemPrompt(prompt: string, preservedSuffix = ""): string {
  const suffix = preservedSuffix ? `\n\n${preservedSuffix}` : "";
  if (suffix.length + OMISSION.length >= MAX_SYSTEM_PROMPT_LENGTH) {
    throw new Error("Voice runtime rules exceed the provider prompt limit");
  }
  if (prompt.length + suffix.length <= MAX_SYSTEM_PROMPT_LENGTH) return prompt + suffix;
  return prompt.slice(0, MAX_SYSTEM_PROMPT_LENGTH - suffix.length - OMISSION.length)
    + OMISSION + suffix;
}

export function composeVoiceSystemPrompt(params: {
  runtime: string;
  background: string;
  businessBrief?: string;
  reminder: string;
  timezone: string;
}): string {
  const sections = splitSections(params.background).filter((section) => {
    // Match generated blocks, not equally named headings in custom instructions.
    const isClock = section.heading === "# Current Date & Time"
      && section.body.startsWith("Server UTC:");
    const isWorkflow = section.heading === "# Instructions"
      && section.body.startsWith("1. Respond helpfully to user requests.");
    return !isClock && !isWorkflow;
  });
  sections.unshift({
    heading: "# Business Timezone",
    body: `${params.timezone}. Confirm dates in this timezone; never infer today's date from the synchronization time.`,
  });
  const brief = params.businessBrief?.trim() || "";
  if (brief.length > MAX_VOICE_BUSINESS_BRIEF_LENGTH) {
    throw new Error("Voice business brief exceeds its reserved prompt budget");
  }
  const available = MAX_SYSTEM_PROMPT_LENGTH - params.runtime.length - params.reminder.length - 4;
  if (available < 2_000) {
    throw new Error("Voice runtime rules leave insufficient room for business context");
  }
  // Reserve the brief in full before campaigns, files and JSON-heavy sections
  // compete for space. Never feed it through weighted excerpt allocation.
  const background = fitBackground(sections, available - (brief ? brief.length + 2 : 0));
  return [params.runtime, brief, background, params.reminder].filter(Boolean).join("\n\n");
}