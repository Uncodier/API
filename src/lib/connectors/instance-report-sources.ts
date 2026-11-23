import 'server-only';
import {z} from 'zod';
import {supabaseAdmin} from '@/lib/database/supabase-client';
import type {scopedAdmission} from './instance-scoped-contract';
import {ConnectorError} from './types';

// This contract accepts logical names only, never a SQL definition or a grant ID.
const reportSources = ['paid_sales','tender_awards','approved_orders'] as const;
export type ReportSource = typeof reportSources[number];
const names = z.array(z.enum(reportSources)).min(1).max(reportSources.length)
  .refine(list => new Set(list).size === list.length);
const matrix = z.object({workspace:names.optional(), platform:names.optional()}).strict();
const unavailable = () => new ConnectorError('DIRECT_POLICY_UNAVAILABLE','Could not verify the eligible report sources.',503);
const denied = () => new ConnectorError('SCOPED_READ_NOT_ALLOWED','No report source is available for this account and turn.',403);

type Actor = Awaited<ReturnType<typeof scopedAdmission>>['actor'];
export async function readInstanceReportSources(actor:Actor) {
  let response;
  try {
    response = await supabaseAdmin.rpc('connector_instance_report_sources',actor).abortSignal(AbortSignal.timeout(5000));
  } catch { throw unavailable(); }
  if (response?.error !== null) throw unavailable();
  if (response.data === null) throw denied();
  const result = matrix.safeParse(response.data);
  if (!result.success) throw unavailable();
  const {workspace,platform} = result.data;
  if (!workspace && !platform) throw denied();
  // All current native platform sources also require their workspace authority.
  if (!workspace || platform?.some(name => !workspace.includes(name))) throw unavailable();
  return {workspace, ...(platform && {platform})};
}
