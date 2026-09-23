export function workflowStepStringList(
  step: Record<string, any>,
  field: string,
): string[] {
  const value = Array.isArray(step[field])
    ? step[field]
    : step.metadata?.[field];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}
