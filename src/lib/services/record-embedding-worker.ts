import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { EmbeddingsService } from '@/lib/services/embeddings-service';
import { SummaryGenerationService } from '@/lib/services/summary/SummaryGenerationService';

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;
const MAX_NODES_PER_RUN = 8;
const EMBEDDING_CONCURRENCY = 4;

type EmbeddingJob = {
  id: string;
  diagram_revision: number;
  node_ids: string[];
  attempts: number;
};

type EmbeddingNode = {
  id: string;
  kind: string;
  title: string;
  content: string;
  metadata: {
    attachments?: Array<{
      name: string;
      mimeType?: string;
      kind?: string;
    }>;
  };
  embedding_source_hash: string | null;
};

type DiagramContext = {
  record: {
    title: string;
    category?: string | null;
  };
  nodes: Array<{
    id: string;
    kind: string;
    title: string;
    content: string;
  }>;
  edges: Array<{
    source: string;
    target: string;
    type: string;
    label?: string | null;
  }>;
};

export async function processRecordEmbeddingsById(input: {
  recordId: string;
  requestedNodeIds?: string[];
}) {
  const { data: record, error: recordError } = await supabaseAdmin
    .from('records')
    .select('id, site_id, title, record_embedding_revision, category:record_categories!records_category_site_fkey(name)')
    .eq('id', input.recordId)
    .maybeSingle();

  if (recordError) throw recordError;
  if (!record) throw new Error('Record not found');

  const jobs = await claimEmbeddingJobs(input.recordId);
  const { data: diagram, error: diagramError } = await supabaseAdmin
    .from('record_diagrams')
    .select('revision')
    .eq('record_id', input.recordId)
    .maybeSingle();

  if (diagramError) throw diagramError;

  const currentRevision = Number(diagram?.revision || 0);
  const requestedIds = input.requestedNodeIds || [];
  const queuedIds = jobs.flatMap((job) => job.node_ids || []);
  const allNodeIds = Array.from(new Set([...requestedIds, ...queuedIds]));
  const nodeIds = allNodeIds.slice(0, MAX_NODES_PER_RUN);
  const remainingNodeIds = allNodeIds.slice(MAX_NODES_PER_RUN);

  try {
    let nodes: EmbeddingNode[] = [];
    if (nodeIds.length > 0) {
      const { data, error } = await supabaseAdmin
        .from('record_diagram_nodes')
        .select('id, kind, title, content, metadata, embedding_source_hash')
        .eq('record_id', input.recordId)
        .in('id', nodeIds);

      if (error) throw error;
      nodes = (data || []) as unknown as EmbeddingNode[];
    }

    const staleNodeIds: string[] = [];
    await mapWithConcurrency(nodes, EMBEDDING_CONCURRENCY, async (node) => {
      const embeddingText = buildNodeEmbeddingText({
        recordTitle: record.title,
        categoryName: readCategoryName(record.category),
        node,
      });
      const nextSourceHash = createHash('sha256').update(embeddingText).digest('hex');
      const embedding = await generateEmbedding(embeddingText);
      const { data: saved, error: saveError } = await supabaseAdmin.rpc(
        'save_record_diagram_node_embedding',
        {
          p_record_id: input.recordId,
          p_node_id: node.id,
          p_diagram_revision: currentRevision,
          p_record_revision: record.record_embedding_revision,
          p_embedding_source_hash: node.embedding_source_hash,
          p_new_embedding_source_hash: nextSourceHash,
          p_embedding: embedding,
          p_embedding_model: EMBEDDING_MODEL,
        },
      );

      if (saveError) throw saveError;
      if (!saved) staleNodeIds.push(node.id);
    });

    const summaryResult = await SummaryGenerationService.summarizeSource({
      collection: 'records',
      id: input.recordId,
      site_id: record.site_id,
    });
    if (!summaryResult.success || !summaryResult.summary) {
      throw new Error(summaryResult.error || 'Summary service returned no text');
    }

    const { data: diagramContext, error: contextError } = await supabaseAdmin
      .rpc('get_record_diagram_context', { p_record_id: input.recordId });
    if (contextError) throw contextError;

    const aggregateText = [
      summaryResult.summary,
      diagramContext
        ? serializeRecordDiagramSemanticText(diagramContext as DiagramContext)
        : '',
    ].filter(Boolean).join('\n\n');
    const aggregateEmbedding = await generateEmbedding(aggregateText);
    const { data: aggregateSaved, error: aggregateError } = await supabaseAdmin
      .rpc('save_record_aggregate_embedding', {
        p_record_id: input.recordId,
        p_diagram_revision: currentRevision,
        p_record_revision: record.record_embedding_revision,
        p_summary: summaryResult.summary,
        p_embedding: aggregateEmbedding,
      });

    if (aggregateError) throw aggregateError;

    const retryNodeIds = Array.from(
      new Set([...remainingNodeIds, ...staleNodeIds]),
    );
    if (retryNodeIds.length > 0 || !aggregateSaved) {
      await enqueueRecordEmbeddingJob(input.recordId, retryNodeIds, true);
    }
    await finishJobs(jobs, null);

    return {
      processedJobs: jobs.length,
      processedNodes: nodes.length,
      remainingNodes: retryNodeIds.length,
      stale: !aggregateSaved || staleNodeIds.length > 0,
    };
  } catch (error) {
    await finishJobs(
      jobs,
      error instanceof Error ? error.message.slice(0, 2000) : 'Embedding failed',
    );
    throw error;
  }
}

async function generateEmbedding(text: string): Promise<number[]> {
  const { embeddings } = await EmbeddingsService.generateEmbeddings(
    text,
    EMBEDDING_MODEL,
    EMBEDDING_DIMENSIONS,
  );
  const embedding = embeddings[0];
  if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error('Embedding service returned an invalid vector');
  }
  return embedding;
}

async function claimEmbeddingJobs(recordId: string): Promise<EmbeddingJob[]> {
  const { data, error } = await supabaseAdmin.rpc('claim_record_embedding_jobs', {
    p_record_id: recordId,
    p_limit: 5,
  });
  if (error) throw error;
  return (data || []) as EmbeddingJob[];
}

async function enqueueRecordEmbeddingJob(
  recordId: string,
  nodeIds: string[],
  replace: boolean,
) {
  const { error } = await supabaseAdmin.rpc('enqueue_record_embedding_job', {
    p_record_id: recordId,
    p_node_ids: nodeIds,
    p_replace: replace,
  });
  if (error) throw error;
}

async function finishJobs(jobs: EmbeddingJob[], error: string | null) {
  if (jobs.length === 0) return;
  const { error: updateError } = await supabaseAdmin
    .from('record_embedding_jobs')
    .update({
      status: error ? 'failed' : 'completed',
      last_error: error,
      completed_at: error ? null : new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .in('id', jobs.map((job) => job.id))
    .eq('status', 'processing');

  if (updateError) throw updateError;
}

function buildNodeEmbeddingText(input: {
  recordTitle: string;
  categoryName?: string | null;
  node: EmbeddingNode;
}): string {
  const attachments = input.node.metadata?.attachments || [];
  return [
    `Record: ${input.recordTitle.trim()}`,
    input.categoryName ? `Category: ${input.categoryName.trim()}` : '',
    `Node type: ${formatNodeKind(input.node.kind)}`,
    `Title: ${input.node.title.trim()}`,
    input.node.content.trim() ? `Content:\n${input.node.content.trim()}` : '',
    attachments.length
      ? `Attachments: ${attachments.map((attachment) =>
          `${attachment.name} (${attachment.mimeType || attachment.kind || 'file'})`
        ).join(', ')}`
      : '',
  ].filter(Boolean).join('\n');
}

function serializeRecordDiagramSemanticText(context: DiagramContext): string {
  const nodeLines = context.nodes.map((node) =>
    [`[${node.kind}] ${node.title}`, node.content.trim()].filter(Boolean).join('\n'),
  );
  const nodeById = new Map(context.nodes.map((node) => [node.id, node]));
  const edgeLines = context.edges.map((edge) => {
    const source = nodeById.get(edge.source)?.title || edge.source;
    const target = nodeById.get(edge.target)?.title || edge.target;
    return `${source} --${edge.type}${edge.label ? ` (${edge.label})` : ''}--> ${target}`;
  });

  return [
    `Record: ${context.record.title}`,
    context.record.category ? `Category: ${context.record.category}` : '',
    nodeLines.length ? `Nodes:\n${nodeLines.join('\n\n')}` : '',
    edgeLines.length ? `Relations:\n${edgeLines.join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}

async function mapWithConcurrency<T>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<void>,
) {
  for (let index = 0; index < values.length; index += concurrency) {
    await Promise.all(values.slice(index, index + concurrency).map(worker));
  }
}

function formatNodeKind(kind: string): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

function readCategoryName(category: unknown): string | null {
  if (Array.isArray(category)) return category[0]?.name || null;
  if (category && typeof category === 'object' && 'name' in category) {
    return String((category as { name: unknown }).name || '') || null;
  }
  return null;
}
