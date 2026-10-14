/** Preserve useful provider classifications without serializing SDK errors/URLs/tokens. */
export function workspaceOpenFailure(error: unknown): { code: string; message: string; operatorRequired: boolean } {
  const candidate = error as { response?: { status?: number; statusCode?: number }; status?: number } | null;
  const status = candidate?.response?.status ?? candidate?.response?.statusCode ?? candidate?.status;
  if (status === 401 || status === 403) return { code: 'WORKSPACE_AUTHORIZATION_REQUIRED',
    message: `Sandbox provider rejected workspace access (HTTP ${status}). Check the host token and team/project scope. Existing work was preserved.`, operatorRequired: true };
  if (status === 402) return { code: 'WORKSPACE_PROVIDER_BILLING_REQUIRED',
    message: 'Sandbox provider rejected workspace access (HTTP 402). Check provider billing; site credits are separate. Existing work was preserved.', operatorRequired: true };
  return { code: 'WORKSPACE_OPEN_FAILED', message: 'Workspace could not be opened. Existing state was not recreated or reset.', operatorRequired: false };
}

export function workspaceOpenRequiresOperator(error: unknown): boolean {
  const candidate = error as { name?: string; code?: string } | null;
  return candidate?.name === 'WorkspaceError' && ['WORKSPACE_AUTHORIZATION_REQUIRED', 'WORKSPACE_PROVIDER_BILLING_REQUIRED'].includes(candidate.code || '');
}