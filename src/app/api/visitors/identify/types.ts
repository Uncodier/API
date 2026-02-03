import { z } from 'zod';

export const identifySchema = z.object({
  site_id: z.string(),
  id: z.string(),
  lead_id: z.string().optional(),
  segment_id: z.string().optional(),
  traits: z.object({
    email: z.string().email().optional(),
    phone: z.string().optional(),
    name: z.string().optional(),
    position: z.string().optional(),
    birthday: z.string().optional(),
    origin: z.string().optional(),
    social_networks: z.record(z.string()).optional(),
    address: z.object({
      street: z.string().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      postalCode: z.string().optional(),
      country: z.string().optional()
    }).optional(),
    company: z.object({
      name: z.string().optional(),
      industry: z.string().optional(),
      employee_count: z.number().optional()
    }).optional(),
    subscription: z.object({
      plan: z.string().optional(),
      status: z.string().optional(),
      started_at: z.string().optional()
    }).optional()
  }).optional(),
  timestamp: z.number().optional(),
}).refine((data) => data.lead_id || (data.traits && (data.traits.email || data.traits.phone || data.traits.name)), {
  message: "Either lead_id or traits with email/phone/name must be provided",
  path: ["lead_id", "traits"],
});

export type IdentifyRequest = z.infer<typeof identifySchema>;
