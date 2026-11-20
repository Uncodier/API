import { z } from 'zod';
import { isPublicationLabel } from './support-public-gmail';

// A fixed publication of Gmail subjects, not a generic public tool grant.
export const supportPublicationSchema = z.object({
  audience: z.enum(['anonymous', 'verified']),
  label_id: z.string().refine(isPublicationLabel),
}).strict();

export type SupportPublication = z.infer<typeof supportPublicationSchema>;
