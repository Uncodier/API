const BROWSER_INTERACTION_INTENT =
  /\b(?:click|select|choose|filter|apply|toggle|pick|submit|fill|type|press|interact|clic|seleccion\w*|filtr\w*|elegir|elige|escog\w*|aplicar|aplica|rellen\w*|complet\w*|escrib\w*|ingres\w*|envi\w*|presion\w*)\b/i;
const DIRECT_CLICK_INTENT = /\b(?:click|clic)\b/i;
const UI_ACTION_INTENT =
  /\b(?:select|choose|toggle|pick|press|fill|type|seleccion\w*|elegir|elige|escog\w*|presion\w*|rellen\w*|escrib\w*)\b/i;
const UI_TARGET =
  /\b(?:option|button|field|input|form|dropdown|menu|checkbox|radio|link|filter|opcion|boton|campo|formulario|menu|casilla|enlace|filtro)\b/i;
const FILTER_ACTION =
  /\b(?:apply|select|choose|aplicar|aplica|seleccion\w*|elegir|elige)\b[^.\n]{0,80}\b(?:filter|filtro)\b/i;

export interface BrowserInteractionStepContract {
  title?: unknown;
  description?: unknown;
  instructions?: unknown;
  browser_interaction_required?: unknown;
  metadata?: Record<string, unknown>;
}

function normalizedContractText(step: BrowserInteractionStepContract): string {
  return [
    step.title,
    step.description,
    step.instructions,
  ]
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

export function workflowStepRequiresBrowserInteraction(
  step: BrowserInteractionStepContract,
): boolean {
  const explicit =
    step.browser_interaction_required ??
    step.metadata?.browser_interaction_required;
  if (typeof explicit === 'boolean') return explicit;
  return BROWSER_INTERACTION_INTENT.test(normalizedContractText(step));
}

export function workflowStepSuggestsBrowserInteraction(
  step: BrowserInteractionStepContract,
): boolean {
  const explicit =
    step.browser_interaction_required ??
    step.metadata?.browser_interaction_required;
  if (typeof explicit === 'boolean') return explicit;
  const text = normalizedContractText(step);
  return (
    DIRECT_CLICK_INTENT.test(text) ||
    FILTER_ACTION.test(text) ||
    (UI_ACTION_INTENT.test(text) && UI_TARGET.test(text))
  );
}
