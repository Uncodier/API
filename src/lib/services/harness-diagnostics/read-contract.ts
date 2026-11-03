/** Host-owned diagnostic reads. Classification never grants dispatch permissions. */
export function isHarnessDiagnosticRead(name: string): boolean {
  return ['harness_inspect', 'harness_events', 'harness_reference', 'harness_source'].includes(name);
}