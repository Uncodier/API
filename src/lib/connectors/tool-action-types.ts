import { z } from 'zod';

const providerTags = {
  read: 'readOnlyHint', create: 'createHint', update: 'updateHint', delete: 'destructiveHint',
} as const;

export const toolActionFilter = z.enum(['read', 'create', 'update', 'delete', 'unclassified']);
export type ToolActionFilter = z.infer<typeof toolActionFilter>;
export type TaggedToolAction = Exclude<ToolActionFilter, 'unclassified'>;
const actions = Object.keys(providerTags) as TaggedToolAction[];

export function providerTagFor(action: TaggedToolAction) {
  return providerTags[action];
}

export function classifyToolActions(tags: unknown): TaggedToolAction[] {
  return Array.isArray(tags) ? actions.filter(action => tags.includes(providerTagFor(action))) : [];
}