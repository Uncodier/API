import { createRecordCore } from "./create/route";
import { getRecordsCore } from "./get/route";
import { updateRecordCore } from "./update/route";
import { deleteRecordCore } from "./delete/route";

export interface RecordToolParams {
  action: "create" | "list" | "update" | "delete";
  record_id?: string;
  category_id?: string;
  title?: string;
  description?: string;
  summary?: string;
  data?: Record<string, any>;
  relations?: Record<string, any>;
  status?: string;
  limit?: number;
  offset?: number;
}

export function recordTool(site_id: string) {
  return {
    name: "record",
    description:
      'Manage dynamic data records. Use this tool to store, read, update, or delete unstructured or semi-structured data (saved in the "data" JSONB field) conforming to a previously defined record_category. Useful for storing things like parsed emails, support tickets, or generated content during a workflow.',
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "list", "update", "delete"],
          description: "Action to perform on records.",
        },
        record_id: {
          type: "string",
          description: "Record UUID (required for update/delete/get specific)",
        },
        category_id: {
          type: "string",
          description: "Category UUID this record belongs to",
        },
        title: { type: "string", description: "Title of the record" },
        description: { type: "string", description: "Optional description" },
        summary: { type: "string", description: "Optional 1-3 sentence factual summary of the record" },
        data: {
          type: "object",
          description:
            "JSON object containing the dynamic data payload conforming to the category schema",
        },
        relations: {
          type: "object",
          description: "JSON object defining relations to other entities",
        },
        status: {
          type: "string",
          description:
            'Status of the record (e.g. "draft", "active", "archived")',
        },
        limit: { type: "number", description: "Limit results for list action" },
        offset: {
          type: "number",
          description: "Offset results for list action",
        },
      },
      required: ["action"],
    },
    execute: async (args: RecordToolParams) => {
      console.log("[RecordTool] Execute called with action:", args.action);
      const params = { ...args, site_id };

      switch (args.action) {
        case "create":
          if (!params.title) throw new Error("Missing required field: title");
          return createRecordCore(params);
        case "list":
          return getRecordsCore(params);
        case "update":
          if (!params.record_id)
            throw new Error("Missing required field: record_id");
          return updateRecordCore(params);
        case "delete":
          if (!params.record_id)
            throw new Error("Missing required field: record_id");
          return deleteRecordCore(params);
        default:
          throw new Error(`Invalid action: ${args.action}`);
      }
    },
  };
}
