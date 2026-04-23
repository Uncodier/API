import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { updateRequirement, getRequirementById } from '@/lib/database/requirement-db';
import { shouldUseRemoteApi, invokeRemoteTool, RemoteToolError } from '@/lib/mcp/remote-client';
import {
  parseGitBindingFromMetadata,
  normalizeGitBindingInput,
  type GitBinding,
} from '@/lib/services/requirement-git-binding';
import { canCloseRequirement } from '@/lib/services/requirement-flow-engine';
import {
  PartialRequirementMetadataSchema,
  verifyGitBindingReachable,
} from '../git-binding-schema';

const UpdateRequirementSchema = z.object({
  requirement_id: z.string().uuid('Requirement ID must be a valid UUID'),
  site_id: z.string().uuid('Site ID is required'),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  instructions: z.string().optional(),
  priority: z.enum(['high', 'medium', 'low']).optional(),
  status: z.enum(['backlog', 'validated', 'in-progress', 'on-review', 'done', 'canceled']).optional(),
  completion_status: z.enum(['pending', 'completed', 'rejected']).optional(),
  type: z.string().optional(),
  budget: z.number().optional(),
  cron: z.string().optional(),
  cycle: z.string().optional(),
  metadata: PartialRequirementMetadataSchema.optional(),
});

/**
 * Core function to update a requirement
 */
export async function updateRequirementCore(params: any) {
  if (shouldUseRemoteApi()) {
    console.log('[Requirements Update] Using Remote API mode');
    return invokeRemoteTool('/api/agents/tools/requirements/update', params);
  }

  const validated = UpdateRequirementSchema.parse(params);


  const { requirement_id, site_id, ...updateFields } = validated;

  const existing = await getRequirementById(requirement_id);
  if (!existing) {
    throw new Error('Requirement not found');
  }

  if (existing.site_id !== site_id) {
    throw new Error('No tienes permiso para actualizar este requerimiento');
  }

  // Phase 10 guardrail: reject a requirement closure while core backlog items
  // are still pending. This blocks the classic loop where the orchestrator
  // flips completion_status='completed' after delivering only a landing.
  const wantsClose =
    updateFields.completion_status === 'completed' ||
    updateFields.status === 'done';
  if (wantsClose) {
    try {
      const gate = await canCloseRequirement(requirement_id);
      if (!gate.ok) {
        throw new Error(`Cannot close requirement: ${gate.reason}. Rewrite acceptance with executable anchors, downgrade narrative items to tier='ornamental', or finish the pending core items before setting completion_status='completed'.`);
      }
    } catch (e: unknown) {
      if (e instanceof Error && e.message.startsWith('Cannot close requirement:')) throw e;
      console.warn(`[RequirementsUpdate] canCloseRequirement check failed (continuing): ${e instanceof Error ? e.message : e}`);
    }
  }

  // If metadata.git is present, merge against the existing binding so callers
  // can submit partial updates (e.g. only `repo`) without wiping the rest.
  if (updateFields.metadata && (updateFields.metadata as Record<string, unknown>).git) {
    const incomingGit = (updateFields.metadata as Record<string, unknown>).git as Partial<GitBinding>;
    const currentBinding = parseGitBindingFromMetadata(existing.metadata);
    const merged = normalizeGitBindingInput(incomingGit, currentBinding ?? {});
    if (!merged) {
      throw new Error(
        'metadata.git is incomplete: provide kind, org, repo, default_branch or omit the field entirely.',
      );
    }
    const reachErr = await verifyGitBindingReachable(merged);
    if (reachErr && process.env.REQUIREMENT_GIT_STRICT === 'true') {
      throw new Error(`metadata.git not reachable: ${reachErr}`);
    }
    (updateFields.metadata as Record<string, unknown>).git = merged;
  }

  const requirement = await updateRequirement(requirement_id, updateFields);

  return {
    success: true,
    requirement,
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = await updateRequirementCore(body);
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
    const status = errorMessage === 'Requirement not found' ? 404 : (errorMessage === 'No tienes permiso para actualizar este requerimiento' ? 403 : 500);
    return NextResponse.json({
      success: false,
      error: errorMessage,
    }, { status: status });
  }
}

export async function PUT(request: NextRequest) {
  return POST(request);
}
