import type { ToolArgumentIssue } from '@/lib/tools/argument-contract';
import { ConnectorError } from './types';

/** Produced only by a local contract check. The runtime, not this error type, marks the dispatch boundary. */
export class ConnectorArgumentError extends ConnectorError {
  constructor(readonly issue: ToolArgumentIssue) {
    super('INVALID_TOOL_ARGUMENTS', 'Arguments do not match the described connector schema.', 400);
  }
}