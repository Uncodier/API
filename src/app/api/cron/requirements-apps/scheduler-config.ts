/** Must match DB check `remote_instances_instance_type_check`. */
export const REMOTE_INSTANCE_TYPE_CRON_APPS = 'browser' as const;
const DEFAULT_MAX_CONCURRENT_REQUIREMENT_RUNS = 8;
const DEFAULT_REQUIREMENT_EVALUATION_LIMIT = 100;

export function getMaxConcurrentRequirementRuns(): number {
  const configured = Number.parseInt(
    process.env.CRON_MAX_CONCURRENT_REQUIREMENT_RUNS || '',
    10,
  );
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_CONCURRENT_REQUIREMENT_RUNS;
}

export function getRequirementEvaluationLimit(): number {
  const configured = Number.parseInt(
    process.env.CRON_REQUIREMENT_EVALUATION_LIMIT || '',
    10,
  );
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_REQUIREMENT_EVALUATION_LIMIT;
}

export function readExecutionGeneration(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string' && /^[0-9]{1,9}$/.test(value)) {
    return Number.parseInt(value, 10);
  }
  return 0;
}

export function cronRemoteInstancePayload(base: {
  site_id: string;
  user_id: string;
  name: string;
  created_by: string;
  instance_type?: string;
}) {
  return {
    ...base,
    status: 'pending' as const,
    instance_type: base.instance_type || REMOTE_INSTANCE_TYPE_CRON_APPS,
    provider_instance_id: null as string | null,
    cdp_url: null as string | null,
  };
}
