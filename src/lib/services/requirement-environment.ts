export type RequirementEnvironment = 'cloud' | 'workspace';

export class RequirementEnvironmentError extends Error {
  constructor(message: string, readonly status: 400 | 409 = 400) {
    super(message);
    this.name = 'RequirementEnvironmentError';
  }
}

/** Persisted metadata is authoritative; never infer execution from title/type/git. */
export function resolveRequirementEnvironment(metadata: unknown): RequirementEnvironment {
  if (metadata == null) return 'workspace';
  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new RequirementEnvironmentError('Invalid requirement execution metadata');
  }
  if (!Object.prototype.hasOwnProperty.call(metadata, 'execution_environment')) return 'workspace';
  const value = (metadata as Record<string, unknown>).execution_environment;
  if (value === 'cloud' || value === 'workspace') return value;
  throw new RequirementEnvironmentError('execution_environment must be cloud or workspace');
}

/** First-class input selects the mode; conflicting metadata is rejected, not silently overwritten. */
export function resolveRequirementEnvironmentInput(
  metadata: unknown,
  executionEnvironment?: RequirementEnvironment,
): RequirementEnvironment {
  const metadataEnvironment = resolveRequirementEnvironment(metadata);
  if (executionEnvironment === undefined) return metadataEnvironment;
  const requested = resolveRequirementEnvironment({ execution_environment: executionEnvironment });
  if (metadata != null && Object.prototype.hasOwnProperty.call(metadata, 'execution_environment') &&
      metadataEnvironment !== requested) {
    throw new RequirementEnvironmentError('execution_environment conflicts with metadata.execution_environment');
  }
  return requested;
}