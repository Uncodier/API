/** Per-suite mock of the exact private lookup only; no access or provider-binding code is replaced. */
export const byokRpc = 'connector_attested_provider_project';
export const byokOrigin = 'https://app.example.test';
export function attestedProject(provider: {site_id: string; credential_revision: string; project_id: string}) {
  return (name: string, args: Record<string, unknown>) => {
    if (name !== byokRpc) throw new Error('Unexpected provider registry operation');
    const data = args.p_site_id === provider.site_id && args.p_credential_revision === provider.credential_revision
      && args.p_oauth_verifier_url === `${byokOrigin}/connectors/callback` ? provider.project_id : null;
    return { abortSignal: async () => ({data, error: null}) };
  };
}
