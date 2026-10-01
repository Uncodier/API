import { randomBytes } from "node:crypto";
import { buildVoiceBusinessBrief, MAX_VOICE_BUSINESS_BRIEF_LENGTH } from "../voice-business-brief";

it("keeps every service name despite long descriptions and never serializes private offering fields", () => {
  const privateValue = randomBytes(32).toString("hex");
  const names = ["Consulting", "Starter", "Enterprise", "API", "Technical support"];
  const source = {
    site: { name: "Northstar Software", description: "Business applications and CRM" },
    settings: {
      about: "Aplicaciones de negocio con inteligencia artificial",
      services: names.map((name) => ({ name, description: "Details ".repeat(2_000), cost: 8291, metadata: { token: privateValue } })),
    },
  };
  const brief = buildVoiceBusinessBrief(source, "Morgan");
  expect(brief).toContain("Business name: Northstar Software");
  expect(brief).toContain("You are Morgan, speaking for this business");
  expect(brief).toContain(source.settings.about);
  expect(brief).toContain(`Services: ${names.join("; ")}`);
  expect(brief).toContain("clarify instead of adopting it");
  expect(brief).toContain("first state this business's name");
  expect(brief).toContain("Do not ask for an offering subtype, date or time until clarified");
  expect(brief).not.toContain("8291");
  expect(brief).not.toContain(privateValue);
  expect(brief).not.toContain("Details");
  expect(brief.length).toBeLessThanOrEqual(MAX_VOICE_BUSINESS_BRIEF_LENGTH);
});

it("keeps the brief bounded and marks omitted names without inventing facts", () => {
  const brief = buildVoiceBusinessBrief({
    site: { name: "Business ".repeat(100), description: "Overview ".repeat(200) },
    settings: {
      services: Array.from({ length: 500 }, (_, i) => ({ name: `Service ${i}` })),
      products: ["A product", { name: "A second product" }],
    },
  }, "Assistant ".repeat(100));
  expect(brief).toContain("more omitted; use tools");
  expect(brief).toContain("Products: A product; A second product");
  expect(brief).toContain("not live availability or prices");
  expect(brief.length).toBeLessThanOrEqual(MAX_VOICE_BUSINESS_BRIEF_LENGTH);
});

it("handles missing sources and malformed collections without inventing a business name", () => {
  const brief = buildVoiceBusinessBrief({ site: null, settings: { services: {}, products: null } }, "Agent");
  expect(brief).toContain("Business name unavailable");
  expect(brief).not.toContain("Business name: Agent");
  expect(brief).not.toContain("Services:");
  expect(brief).not.toContain("Products:");
});

it("deduplicates names and flattens newlines in configured facts", () => {
  const brief = buildVoiceBusinessBrief({
    site: { name: "Northstar\n\nSoftware", description: "Applications" },
    settings: { services: [null, {}, { name: 42 }, "Consulting", { name: "Consulting" }, "Technical\nsupport"] },
  }, "Morgan");
  expect(brief).toContain("Business name: Northstar Software");
  expect(brief).toContain("Services: Consulting; Technical support");
  expect(brief).not.toContain("undefined");
});