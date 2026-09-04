export type PlanStepLike = {
  id?: string;
  title?: string;
  order?: number;
  status?: string;
};

export function resolveExecuteStepId(params: {
  step_id?: string;
  title?: string;
  order?: number;
  steps?: PlanStepLike[] | null;
}): { stepId: string | null; error?: string } {
  const steps = Array.isArray(params.steps) ? params.steps : [];
  const rawId = String(params.step_id || '').trim();
  if (rawId) {
    const byId = steps.find((s) => String(s.id) === rawId);
    if (byId?.id) return { stepId: String(byId.id) };
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawId) && steps.length === 0) {
      return { stepId: rawId };
    }
    const byTitle = steps.find((s) => String(s.title || '').trim().toLowerCase() === rawId.toLowerCase());
    if (byTitle?.id) return { stepId: String(byTitle.id) };
  }

  const title = String(params.title || '').trim().toLowerCase();
  if (title) {
    const byTitle = steps.find((s) => String(s.title || '').trim().toLowerCase() === title);
    if (byTitle?.id) return { stepId: String(byTitle.id) };
  }

  if (typeof params.order === 'number' && Number.isFinite(params.order)) {
    const byOrder = steps.find((s) => Number(s.order) === params.order);
    if (byOrder?.id) return { stepId: String(byOrder.id) };
  }

  const known = steps
    .map((s) => `${s.order ?? '?'}:${s.title || s.id || '?'}`)
    .slice(0, 12)
    .join(', ');
  return {
    stepId: null,
    error: `Could not resolve execute_step. Pass step_id (UUID), title, or order matching the active plan. Known steps: ${known || '(none loaded)'}.`,
  };
}
