import { randomBytes } from "node:crypto";
import { getCustomerSupportVoiceToolDefinitions } from "../voice-tool-catalog";
import {
  projectVoiceToolParameters,
  validateVoiceToolArguments,
  VoiceToolArgumentValidationError,
} from "../voice-tool-parameters";

function tool(name: string) {
  return getCustomerSupportVoiceToolDefinitions("site-1").find((entry) => entry.name === name)!;
}

function validationError(name: string, args: Record<string, unknown>) {
  try {
    validateVoiceToolArguments(tool(name), args);
    throw new Error("Expected validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(VoiceToolArgumentValidationError);
    return error as VoiceToolArgumentValidationError;
  }
}

describe("voice tool parameter projection", () => {
  it("puts enum choices into provider-compatible descriptions without mutating source schemas", () => {
    const catalog = tool("catalog_commerce");
    const sourceBefore = JSON.stringify(catalog.parameters);
    const projected = projectVoiceToolParameters(catalog) as any;

    expect(projected.required).toEqual(["action"]);
    expect(projected.properties.resource).toEqual({
      type: "string",
      description: expect.stringContaining('Allowed values: "item", "modifier_group"'),
    });
    expect(projected.properties.action.description).toContain('"create", "list", "get", "update", "delete"');
    expect(projected.properties.kind.description).toContain('"product", "service", "digital_asset"');
    expect(JSON.stringify(catalog.parameters)).toBe(sourceBefore);
    expect(catalog.parameters.properties).toHaveProperty("resource.enum");
  });

  it("describes nested required fields and array item shapes even when nested schemas cannot survive", () => {
    const tasks = projectVoiceToolParameters(tool("CREATE_TASK")) as any;
    expect(tasks.properties.address).toEqual({ type: "object", description: expect.any(String) });
    expect(tasks.properties.address.description).toContain("Required fields: street, city, country.");
    expect(tasks.properties.address.description).toContain("street (Type: string. Street address)");
    expect(tasks.properties.scheduled_date.description).toContain("date-time with timezone required");

    const promotions = projectVoiceToolParameters(tool("promotions")) as any;
    expect(promotions.properties.channels.description)
      .toContain('Each array item: Type: string. Allowed values: "marketplace", "shop", "pos".');
    expect(promotions.properties.required_items.description).toContain("Each array item: Type: object.");
    expect(promotions.properties.required_items.description).toContain("catalog_item_id (Type: string.)");
    expect(promotions.properties.required_items.description).toContain("min_quantity (Type: number.)");
  });

  it("preserves integer/range and known alternative identifier guidance", () => {
    const tasks = projectVoiceToolParameters(tool("GET_TASKS")) as any;
    expect(tasks.properties.limit).toMatchObject({ type: "number" });
    expect(tasks.properties.limit.description).toContain("Must be an integer. Minimum: 1. Maximum: 100.");
    const qualify = projectVoiceToolParameters(tool("QUALIFY_LEAD")) as any;
    expect(qualify.properties.lead_id.description).toContain("Provide at least one of lead_id, email, phone.");
  });
});

describe("voice tool source validation", () => {
  it.each([
    ["catalog_commerce", { action: "list", resource: "service" }, ["resource"]],
    ["catalog_commerce", { action: "search", resource: "item" }, ["action"]],
    ["catalog_commerce", { action: "list", kind: "physical" }, ["kind"]],
    ["catalog_commerce", { action: "list", include_modifiers: "true" }, ["include_modifiers"]],
    ["catalog_commerce", { action: "list", limit: "10" }, ["limit"]],
    ["catalog_commerce", { action: "list", metadata: [] }, ["metadata"]],
    ["catalog_commerce", { action: "list", resource: null }, ["resource"]],
    ["catalog_commerce", { action: "list", limit: null }, ["limit"]],
    ["catalog_commerce", { action: "update", max_select: "unlimited" }, ["max_select"]],
    ["catalog_commerce", { resource: "item" }, ["action"]],
    ["GET_TASKS", { lead_id: "lead-1", limit: 1.5 }, ["limit"]],
    ["GET_TASKS", { lead_id: "lead-1", limit: 0 }, ["limit"]],
    ["GET_TASKS", { lead_id: "lead-1", limit: 101 }, ["limit"]],
    ["UPDATE_TASK", { task_id: "task-1", priority: -1 }, ["priority"]],
    ["UPDATE_TASK", { task_id: "task-1", scheduled_date: "2026-01-01" }, ["scheduled_date"]],
    ["promotions", { action: "list", channels: ["shop", "unsupported"] }, ["channels[]"]],
    ["promotions", { action: "list", active_weekdays: ["1"] }, ["active_weekdays[]"]],
    ["promotions", { action: "list", required_items: [{ min_quantity: "2" }] }, ["required_items[].min_quantity"]],
    ["promotions", { action: "list", required_items: ["item"] }, ["required_items[]"]],
  ] as const)("rejects source constraint violations for %s", (name, args, fields) => {
    const error = validationError(name, args);
    expect(error.code).toBe("VOICE_TOOL_INVALID_ARGUMENTS");
    expect(error.fields).toEqual(fields);
    expect(error.message).toContain("Correct only invalid_fields");
  });

  it("validates nested required fields only when the optional parent is supplied", () => {
    const args = {
      title: "Call", type: "call", lead_id: "lead-1", description: "Follow up",
      scheduled_date: "2026-01-01T09:00:00Z", stage: "awareness",
    };
    expect(() => validateVoiceToolArguments(tool("CREATE_TASK"), args)).not.toThrow();
    expect(validationError("CREATE_TASK", { ...args, address: { street: 12, city: "City" } }).fields)
      .toEqual(["address.country", "address.street"]);
    expect(() => validateVoiceToolArguments(tool("CREATE_TASK"), {
      ...args, address: { street: "Street", city: "City", country: "Country", extra: "allowed" },
    })).not.toThrow();
  });

  it("rejects undeclared fields without reflecting their names or sensitive supplied values", () => {
    const secret = randomBytes(24).toString("hex");
    const unknownField = randomBytes(16).toString("hex");
    const error = validationError("GET_TASKS", { lead_id: "lead-1", status: secret, [unknownField]: secret });
    expect(error.fields).toEqual(["status", "arguments"]);
    expect(error.message).toContain('allowed values are "pending", "in_progress", "completed", "failed"');
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain(unknownField);
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(unknownField);
  });

  it("accepts optional/default fields without coercion or interpreting description-only constraints", () => {
    const args = { action: "list", kind: "service", metadata: { arbitrary: [1, true] } };
    const before = JSON.stringify(args);
    expect(() => validateVoiceToolArguments(tool("catalog_commerce"), args)).not.toThrow();
    expect(JSON.stringify(args)).toBe(before);
    expect(args).not.toHaveProperty("resource");
    // Quantity business rules belong to the existing native promotion executor.
    expect(() => validateVoiceToolArguments(tool("promotions"), {
      action: "list", channels: ["shop"], required_items: [{ catalog_item_id: "item-1", min_quantity: 2 }],
    })).not.toThrow();
  });

  it("requires a qualification identifier but allows multiple trusted identifiers", () => {
    const args = { site_id: "site-1", status: "qualified" };
    expect(validationError("QUALIFY_LEAD", args).fields).toEqual(["lead_id", "email", "phone"]);
    expect(() => validateVoiceToolArguments(tool("QUALIFY_LEAD"), {
      ...args, lead_id: "lead-1", phone: "+13015550100",
    })).not.toThrow();
  });

  it("preserves the catalog's documented null=unlimited fields without accepting arbitrary nulls", () => {
    const catalog = tool("catalog_commerce");
    const parameters = projectVoiceToolParameters(catalog) as any;
    expect(parameters.properties.max_select.description).toContain("null = unlimited");
    expect(parameters.properties.pass_uses.description).toContain("null = unlimited");
    expect(() => validateVoiceToolArguments(catalog, {
      action: "update", id: "item-1", max_select: null, pass_uses: null,
    })).not.toThrow();
    expect(validationError("catalog_commerce", { action: "list", min_select: null }).fields).toEqual(["min_select"]);
  });
});