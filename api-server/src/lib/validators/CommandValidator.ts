import { z } from 'zod';

// Tool parameter schema
const ParameterPropertySchema = z.object({
  type: z.string(),
  description: z.string().optional(),
  items: z.object({
    type: z.string()
  }).optional()
});

// Tool parameter properties schema
const ParameterPropertiesSchema = z.record(ParameterPropertySchema);

// Tool parameter schema
const ParameterSchema = z.object({
  type: z.string(),
  properties: ParameterPropertiesSchema,
  required: z.array(z.string()).optional()
});

// Tool schema
const ToolSchema = z.object({
  name: z.string(),
  description: z.string(),
  status: z.string(),
  type: z.string(),
  parameters: ParameterSchema
});

// Supervisor schema
const SupervisorSchema = z.object({
  agent_role: z.string(),
  status: z.string()
});

// Flexible analysis schema - using a more flexible approach
const AnalysisSchema = z.object({
  summary: z.string().optional(),
  insights: z.array(z.string()).optional(),
  sentiment: z.string().optional(),
  priority: z.string().optional(),
  action_items: z.array(z.string()).optional(),
  response_suggestions: z.array(z.string()).optional()
}).passthrough();

// Target schema with flexible analysis
const TargetSchema = z.object({
  analysis: AnalysisSchema
}).passthrough();

// Command validator schema
export const CommandValidator = z.object({
  id: z.string(),
  agent_id: z.string().uuid(),
  site_id: z.string().uuid(),
  team_member_id: z.string().uuid().nullable(),
  status: z.string(),
  task_type: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  priority: z.string(),
  data: z.record(z.any()).optional(),
  targets: z.array(TargetSchema),
  tools: z.array(ToolSchema),
  context: z.string(),
  supervisors: z.array(SupervisorSchema),
  task: z.string(),
  description: z.string()
}).passthrough();

// Types based on the validator
export type CommandValidatorType = z.infer<typeof CommandValidator>; 