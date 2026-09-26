import { calendarBlocksTool } from "@/app/api/agents/tools/calendar_blocks/assistantProtocol";
import { calendarsTool } from "@/app/api/agents/tools/calendars/assistantProtocol";
import { catalogCommerceTool } from "@/app/api/agents/tools/catalog_commerce/assistantProtocol";
import { checkoutTool } from "@/app/api/agents/tools/checkout/assistantProtocol";
import { promotionsTool } from "@/app/api/agents/tools/promotions/assistantProtocol";
import { reservationSchedulesTool } from "@/app/api/agents/tools/reservation_schedules/assistantProtocol";
import { reservationsTool } from "@/app/api/agents/tools/reservations/assistantProtocol";
import { schedulingTool } from "@/app/api/agents/tools/scheduling/assistantProtocol";

export type CustomerSupportToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
  execute?: (args: any) => Promise<any> | any;
};

export type CustomerSupportToolRegistration = {
  type: "function";
  async?: boolean;
  function: CustomerSupportToolDefinition;
};

function asynchronousTool(
  definition: CustomerSupportToolDefinition
): CustomerSupportToolRegistration {
  return { type: "function", async: true, function: definition };
}

function skillLookupDefinition(siteId?: string): CustomerSupportToolDefinition {
  return {
    name: "skill_lookup",
    description:
      "Browse and load Agent Skills (SKILL.md procedures) on demand. Search by intent first, then load a relevant skill by name.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "search", "get"],
          description: "Whether to list, search, or load a skill",
        },
        query: {
          type: "string",
          description: "Natural-language search query",
        },
        skill_name: {
          type: "string",
          description: "Skill name or slug to load",
        },
        limit: {
          type: "number",
          description: "Maximum entries for list or search",
        },
      },
      required: ["action"],
    },
    execute: async (args: any) => {
      const { skillLookupTool } = await import(
        "@/app/api/agents/tools/sandbox/skill-lookup-tool"
      );
      return skillLookupTool({ siteId }).execute(args);
    },
  };
}

function delegateConversationTool(): CustomerSupportToolDefinition {
  return {
    name: "DELEGATE_CONVERSATION",
    description: "escalate when needed to a specific department or role",
    parameters: {
      type: "object",
      properties: {
        conversation: {
          type: "string",
          description: "The conversation ID that needs to be escalated",
        },
        lead_id: {
          type: "string",
          description: "The ID of the lead or customer related to this escalation",
        },
        target: {
          type: "string",
          enum: ["Sales/CRM Specialist", "Growth Lead/Manager"],
          description: "The department or role to escalate the conversation to",
        },
        summary: {
          type: "string",
          description: "A brief summary of the issue or reason for escalation",
        },
      },
      required: ["conversation", "lead_id"],
      additionalProperties: false,
    },
    strict: true,
  };
}

function qualifyLeadTool(siteId?: string): CustomerSupportToolDefinition {
  return {
    name: "QUALIFY_LEAD",
    description:
      "Qualify or update lead status based on conversation outcome and company policy",
    parameters: {
      type: "object",
      properties: {
        site_id: {
          type: "string",
          description: "Site UUID where the lead belongs (required)",
          ...(siteId ? { enum: [siteId] } : {}),
        },
        lead_id: {
          type: "string",
          description:
            "Lead UUID to qualify (one of lead_id, email, or phone is required)",
        },
        email: {
          type: "string",
          description: "Lead email as alternative identifier",
        },
        phone: {
          type: "string",
          description: "Lead phone as alternative identifier",
        },
        status: {
          type: "string",
          enum: ["contacted", "qualified", "converted", "lost"],
          description: "New lead status according to company rules",
        },
        notes: {
          type: "string",
          description: "Short reasoning for the qualification change",
        },
      },
      required: ["site_id", "status"],
      oneOf: [
        { required: ["lead_id"] },
        { required: ["email"] },
        { required: ["phone"] },
      ],
      additionalProperties: false,
    },
    strict: true,
  };
}

function contactHumanTool(): CustomerSupportToolDefinition {
  return {
    name: "CONTACT_HUMAN",
    description:
      "contact human supervisor when complex issues require human intervention",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The found name of the visitor requesting intervention",
        },
        email: {
          type: "string",
          description: "The found email of the visitor requesting intervention",
        },
        conversation_id: {
          type: "string",
          description: "The conversation ID that requires human attention",
        },
        summary: {
          type: "string",
          description: "A brief summary of the issue or reason for escalation",
        },
        message: {
          type: "string",
          description: "The message to send to the human supervisor",
        },
        priority: {
          type: "string",
          enum: ["normal", "high", "urgent"],
          description: "The priority level of the request",
        },
        lead_id: {
          type: "string",
          description: "The ID of the lead or customer that needs assistance",
        },
      },
      required: [
        "conversation_id",
        "summary",
        "message",
        "priority",
        "name",
        "email",
      ],
      additionalProperties: false,
    },
    strict: true,
  };
}

function identifyLeadTool(): CustomerSupportToolDefinition {
  return {
    name: "IDENTIFY_LEAD",
    description:
      "collect visitor information when lead or visitor data is missing from context",
    parameters: {
      type: "object",
      properties: {
        conversation: {
          type: "string",
          description: "The conversation ID for the current interaction",
        },
        name: { type: "string", description: "Name of the visitor" },
        email: { type: "string", description: "Email address of the visitor" },
        phone: { type: "string", description: "Phone number of the visitor" },
        company: { type: "string", description: "Company name of the visitor" },
      },
      required: ["name", "email", "phone"],
      additionalProperties: false,
    },
    strict: true,
  };
}

function createTaskTool(): CustomerSupportToolDefinition {
  return {
    name: "CREATE_TASK",
    description:
      "create a new task for lead follow-up, customer support activities, or other customer interactions",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Title of the task to be created" },
        type: {
          type: "string",
          description:
            "Type of task to create (for example call, email, demo, meeting, quote, payment, follow_up, or support)",
        },
        lead_id: {
          type: "string",
          description: "The ID of the lead this task is related to",
        },
        description: {
          type: "string",
          description: "Detailed description of what needs to be done",
        },
        stage: {
          type: "string",
          enum: [
            "awareness",
            "consideration",
            "decision",
            "purchase",
            "retention",
            "referral",
          ],
          description: "Stage from the customer journey",
        },
        scheduled_date: {
          type: "string",
          format: "date-time",
          description: "Task schedule as an ISO 8601 date-time with timezone",
        },
        notes: { type: "string", description: "Additional task notes" },
        amount: {
          type: "number",
          description: "Monetary amount associated with the task",
        },
        address: {
          type: "object",
          description: "Address information",
          properties: {
            street: { type: "string", description: "Street address" },
            city: { type: "string", description: "City name" },
            state: { type: "string", description: "State or province" },
            postal_code: { type: "string", description: "Postal or ZIP code" },
            country: { type: "string", description: "Country name" },
          },
          required: ["street", "city", "country"],
          additionalProperties: true,
        },
      },
      required: [
        "title",
        "type",
        "lead_id",
        "scheduled_date",
        "stage",
        "description",
      ],
      additionalProperties: false,
    },
    strict: true,
  };
}

function updateTaskTool(): CustomerSupportToolDefinition {
  return {
    name: "UPDATE_TASK",
    description:
      "update an existing task with new information, status changes, or progress updates",
    parameters: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description: "The ID of the task to update",
        },
        title: { type: "string", description: "New task title" },
        type: { type: "string", description: "New task type" },
        description: {
          type: "string",
          description: "New detailed task description",
        },
        status: {
          type: "string",
          enum: ["pending", "in_progress", "completed", "failed"],
          description: "New task status",
        },
        stage: {
          type: "string",
          enum: [
            "awareness",
            "consideration",
            "decision",
            "purchase",
            "retention",
            "referral",
          ],
          description: "New customer journey stage",
        },
        priority: {
          type: "integer",
          minimum: 0,
          description: "New priority level",
        },
        scheduled_date: {
          type: "string",
          format: "date-time",
          description: "New schedule as an ISO 8601 date-time with timezone",
        },
        amount: { type: "number", description: "New monetary amount" },
        assignee: { type: "string", description: "User ID to assign" },
        notes: { type: "string", description: "New or additional notes" },
        address: {
          type: "object",
          description: "New address information",
          properties: {
            street: { type: "string", description: "Street address" },
            city: { type: "string", description: "City name" },
            state: { type: "string", description: "State or province" },
            postal_code: { type: "string", description: "Postal or ZIP code" },
            country: { type: "string", description: "Country name" },
            venue_name: { type: "string", description: "Venue or location name" },
            room: { type: "string", description: "Room or suite number" },
            floor: { type: "string", description: "Floor number" },
            parking_instructions: {
              type: "string",
              description: "Parking instructions",
            },
            access_code: { type: "string", description: "Entry access code" },
          },
          additionalProperties: true,
        },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    strict: true,
  };
}

function getTasksTool(): CustomerSupportToolDefinition {
  return {
    name: "GET_TASKS",
    description:
      "retrieve tasks with filtering options to check order status, track deliveries, and review task progress",
    parameters: {
      type: "object",
      properties: {
        lead_id: {
          type: "string",
          description: "The ID of the lead to get tasks for",
        },
        type: { type: "string", description: "Task type filter" },
        status: {
          type: "string",
          enum: ["pending", "in_progress", "completed", "failed"],
          description: "Task status filter",
        },
        stage: {
          type: "string",
          enum: [
            "awareness",
            "consideration",
            "decision",
            "purchase",
            "retention",
            "referral",
          ],
          description: "Customer journey stage filter",
        },
        priority: { type: "integer", description: "Priority filter" },
        search: { type: "string", description: "Title or description search" },
        sort_by: {
          type: "string",
          enum: ["created_at", "updated_at", "scheduled_date", "priority", "title"],
          description: "Sort field",
        },
        sort_order: {
          type: "string",
          enum: ["asc", "desc"],
          description: "Sort order",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Maximum number of tasks",
        },
        include_completed: {
          type: "boolean",
          description: "Whether completed tasks should be included",
        },
      },
      required: ["lead_id"],
      additionalProperties: false,
    },
    strict: true,
  };
}

export function buildCustomerSupportTools(
  siteId?: string | null
): CustomerSupportToolRegistration[] {
  const scopedSiteId = siteId || undefined;
  const nativeTools = [
    skillLookupDefinition(scopedSiteId),
    catalogCommerceTool(scopedSiteId),
    promotionsTool(scopedSiteId),
    reservationsTool(scopedSiteId),
    reservationSchedulesTool(scopedSiteId),
    calendarBlocksTool(scopedSiteId),
    calendarsTool(scopedSiteId),
    schedulingTool(scopedSiteId || ""),
    checkoutTool(scopedSiteId),
  ];

  const nativeRegistrations = nativeTools.map((tool) => ({
    type: "function" as const,
    function: tool as CustomerSupportToolDefinition,
  }));

  return [
    ...nativeRegistrations,
    asynchronousTool(delegateConversationTool()),
    asynchronousTool(qualifyLeadTool(scopedSiteId)),
    asynchronousTool(contactHumanTool()),
    asynchronousTool(identifyLeadTool()),
    asynchronousTool(createTaskTool()),
    asynchronousTool(updateTaskTool()),
    asynchronousTool(getTasksTool()),
  ];
}

export function getCustomerSupportToolDefinitions(
  siteId?: string | null
): CustomerSupportToolDefinition[] {
  return buildCustomerSupportTools(siteId).map((tool) => tool.function);
}
