import { z } from 'zod';

export const identifySchema = z.object({
  site_id: z.string().uuid(),
  session_id: z.string().uuid(),
  id: z.string().uuid(),
  lead_id: z.string().uuid().optional(),
  segment_id: z.string().uuid().optional(),
  traits: z.object({
    email: z.string().email().optional(),
    phone: z.string().max(100).optional(),
    name: z.string().max(500).optional(),
    position: z.string().max(500).optional(),
    birthday: z.string().max(100).optional(),
    origin: z.string().max(500).optional(),
    social_networks: z.record(z.string().max(2_048)).optional(),
    address: z.object({
      street: z.string().max(500).optional(),
      city: z.string().max(200).optional(),
      state: z.string().max(200).optional(),
      postalCode: z.string().max(50).optional(),
      country: z.string().max(200).optional()
    }).optional(),
    company: z.object({
      name: z.string().max(500).optional(),
      industry: z.string().max(500).optional(),
      employee_count: z.number().optional()
    }).optional(),
    subscription: z.object({
      plan: z.string().max(200).optional(),
      status: z.string().max(200).optional(),
      started_at: z.string().max(100).optional()
    }).optional()
  }).optional(),
  timestamp: z.number().optional(),
}).refine((data) => data.lead_id || (data.traits && (data.traits.email || data.traits.phone || data.traits.name)), {
  message: "Either lead_id or traits with email/phone/name must be provided",
  path: ["lead_id", "traits"],
});

export type IdentifyRequest = z.infer<typeof identifySchema>;
