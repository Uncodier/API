import { resolveNumberedTemplate } from "./support";

describe("resolveNumberedTemplate", () => {
  it("resolves every repeated numbered placeholder", () => {
    expect(resolveNumberedTemplate(
      "Hello {{1}} from {{2}}. Bye {{1}}.",
      { "1": "Ana", "2": "Acme" }
    )).toBe("Hello Ana from Acme. Bye Ana.");
  });

  it("strips a missing variable instead of sending its placeholder", () => {
    expect(resolveNumberedTemplate("Hello {{1}} {{2}}", { "1": "Ana" }))
      .toBe("Hello Ana ");
  });
});
