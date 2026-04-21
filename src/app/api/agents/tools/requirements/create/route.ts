import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { createRequirement } from '@/lib/database/requirement-db';
import { shouldUseRemoteApi, invokeRemoteTool, RemoteToolError } from '@/lib/mcp/remote-client';
import {
  normalizeGitBindingInput,
  resolveDefaultGitBinding,
  type GitBinding,
} from '@/lib/services/requirement-git-binding';
import {
  PartialRequirementMetadataSchema,
  verifyGitBindingReachable,
} from '../git-binding-schema';

const CreateRequirementSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  description: z.string().optional(),
  instructions: z.string().optional(),
  priority: z.enum(['high', 'medium', 'low']).optional().default('medium'),
  status: z.enum(['backlog', 'validated', 'in-progress', 'on-review', 'done', 'canceled']).optional().default('backlog'),
  type: z.string().optional().default('task'),
  budget: z.number().optional(),
  cron: z.string().optional(),
  cycle: z.string().optional(),
  site_id: z.string().uuid('Valid site_id required'),
  user_id: z.string().uuid('Valid user_id required').optional(),
  campaign_id: z.string().uuid().optional(),
  metadata: PartialRequirementMetadataSchema.optional(),
});

async function resolveUserId(siteId: string, userId?: string): Promise<string> {
  if (userId) return userId;
  const { data } = await supabaseAdmin
    .from('sites')
    .select('user_id')
    .eq('id', siteId)
    .single();
  if (!data?.user_id) {
    throw new Error('user_id required: provide it or ensure site has user_id');
  }
  return data.user_id;
}

/**
 * Core function to create a requirement
 */
export async function createRequirementCore(params: any) {
  if (shouldUseRemoteApi()) {
    console.log('[Requirements Create] Using Remote API mode');
    return invokeRemoteTool('/api/agents/tools/requirements/create', params);
  }

  const validated = CreateRequirementSchema.parse(params);
  const effectiveUserId = await resolveUserId(validated.site_id, validated.user_id);

  // Auto-seed metadata.git when the caller did not provide a full binding,
  // so every new requirement has an explicit repo target that the sync
  // pipeline can validate without re-reading env vars.
  const incomingMetadata = (validated.metadata ?? {}) as Record<string, unknown>;
  const incomingGit = (incomingMetadata.git ?? {}) as Partial<GitBinding>;
  const defaultBinding = resolveDefaultGitBinding(validated.type);
  const seededBinding =
    normalizeGitBindingInput(incomingGit, defaultBinding) ?? defaultBinding;
  const reachErr = await verifyGitBindingReachable(seededBinding);
  if (reachErr && process.env.REQUIREMENT_GIT_STRICT === 'true') {
    throw new Error(`metadata.git not reachable: ${reachErr}`);
  }
  const seededMetadata: Record<string, unknown> = {
    ...incomingMetadata,
    git: seededBinding,
  };

  const requirement = await createRequirement({
    title: validated.title,
    description: validated.description,
    instructions: validated.instructions,
    priority: validated.priority,
    status: validated.status,
    type: validated.type,
    budget: validated.budget,
    site_id: validated.site_id,
    user_id: effectiveUserId,
    campaign_id: validated.campaign_id,
    cron: validated.cron,
    cycle: validated.cycle,
    metadata: seededMetadata,
  });

  return {
    success: true,
    requirement,
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = await createRequirementCore(body);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({
        success: false,
        error: 'Invalid input',
        details: error.errors,
      }, { status: 400 });
    }

    if (error instanceof RemoteToolError) {
      return NextResponse.json(error.data || {
        success: false,
        error: error.message
      }, { status: error.status });
    }

    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({
      success: false,
      error: errorMessage,
    }, { status: 500 });
  }
}