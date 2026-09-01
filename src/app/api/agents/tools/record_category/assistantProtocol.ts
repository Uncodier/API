import { createRecordCategoryCore } from "./create/route";
import { getRecordCategoriesCore } from "./get/route";
import { updateRecordCategoryCore } from "./update/route";
import { deleteRecordCategoryCore } from "./delete/route";

export interface RecordCategoryToolParams {
  action: "create" | "list" | "update" | "delete";
  category_id?: string;
  name?: string;
  description?: string;
  icon?: string;
  parent_category_id?: string;
  template_fields?: any[];
  limit?: number;
  offset?: number;
}

export function recordCategoryTool(site_id: string) {
  return {
    name: "record_category",
    description:
      'Manage dynamic data schemas (categories) for records. Use this tool to define the structure (template_fields) of information you want to store in workflows, such as "Leads", "Invoices", or "Support Tickets".',
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "list", "update", "delete"],
          description: "Action to perform on record categories.",
        },
        category_id: {
          type: "string",
          description:
            "Category UUID (required for update/delete/get specific)",
        },
        name: {
          type: "string",
          description: 'Name of the category (e.g. "Leads")',
        },
        description: {
          type: "string",
          description: "Description of what this category stores",
        },
        icon: { type: "string", description: "Optional icon name" },
        parent_category_id: {
          type: "string",
          description: "Optional parent category UUID for hierarchy",
        },
        template_fields: {
          type: "array",
          items: { type: "object" },
          description:
            'Array defining the schema fields (e.g. [{"name":"email","type":"string","required":true}])',
        },
        limit: { type: "number", description: "Limit results for list action" },
        offset: {
          type: "number",
          description: "Offset results for list action",
        },
      },
      required: ["action"],
    },
    execute: async (args: RecordCategoryToolParams) => {
      console.log(
        "[RecordCategoryTool] Execute called with action:",
        args.action,
      );
      const params = { ...args, site_id };

      switch (args.action) {
        case "create":
          if (!params.name) throw new Error("Missing required field: name");
          return createRecordCategoryCore(params);
        case "list":
          return getRecordCategoriesCore(params);
        case "update":
          if (!params.category_id)
            throw new Error("Missing required field: category_id");
          return updateRecordCategoryCore(params);
        case "delete":
          if (!params.category_id)
            throw new Error("Missing required field: category_id");
          return deleteRecordCategoryCore(params);
        default:
          throw new Error(`Invalid action: ${args.action}`);
      }
    },
  };
}
