import { ASK_OWNER_RESULT } from '@/lib/connectors/provider-live-result';

const connectorId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

/** Only actual tool replies can select this audience; provider data is nested
 * under result and cannot write these host-owned envelope fields. */
export function ownerConnectorTranscript(messages: readonly unknown[]) {
  let start: number | undefined;
  const connectors = new Set<string>();
  const toolContext: {claim_id:string; result:unknown}[] = [];
  const claims = new Set<string>(), recordUrls = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i] as { role?: unknown; content?: unknown } | undefined;
    if (message?.role !== 'tool' || typeof message.content !== 'string' || message.content.length > 65_536) continue;
    try {
      const reply = JSON.parse(message.content);
      if (reply?.success !== true || reply.result_visibility !== ASK_OWNER_RESULT || typeof reply.result_connector_id !== 'string' ||
          !connectorId.test(reply.result_connector_id) || typeof reply.result_claim_id !== 'string' ||
          !connectorId.test(reply.result_claim_id) || (!Object.hasOwn(reply, 'result') && reply.result_omitted !== true)) continue;
      // Drop the requesting assistant message and every later utterance from the
      // shared recovery copy. Even a later tool argument can repeat these data.
      if (start === undefined) {
        start = Math.max(0, i - 1);
        while (start > 0 && (messages[start] as {role?:unknown})?.role !== 'assistant') start--;
      }
      connectors.add(reply.result_connector_id);
      if (!claims.has(reply.result_claim_id)) {
        const result = { ...(Object.hasOwn(reply,'result') ? {value:reply.result} : {omitted:true}),
          ...(reply.result_truncated === true && {truncated:true}), ...(reply.result_fields_omitted === true && {fields_omitted:true}),
          ...(reply.result_facts && {facts:reply.result_facts}) };
        toolContext.push({claim_id:reply.result_claim_id, result});
        while (toolContext.length > 8 || Buffer.byteLength(JSON.stringify(toolContext)) > 65_536) toolContext.shift();
      }
      claims.add(reply.result_claim_id);
      const url = reply.receipt?.url;
      if (reply.receipt?.status === 'private_result_ready' && typeof url === 'string' && url.startsWith('/connectors/results/') &&
          connectorId.test(url.slice('/connectors/results/'.length))) recordUrls.add(url);
    } catch { /* Non-JSON tool replies are not an owner-result envelope. */ }
  }
  if (start !== undefined) return { start, connectorIds:[...connectors], toolContext, claimIds:[...claims],recordUrls:[...recordUrls] };
}

export function appendOwnerRecordLinks(text: string, urls: readonly string[]) {
  const missing = urls.filter(url => !text.includes(`](${url})`));
  return missing.length ? `${text}\n\n${missing.map(url => `[Open saved connector result](${url})`).join('\n')}` : text;
}

export function ownerConnectorFollowupAllowed(connector: string, tool: string, raw: unknown) {
  if (!raw || typeof raw !== 'object') return false;
  const args = raw as { action?: string; name?: string; action_name?: string; connector_id?: string; tool_origin?: string; args?: unknown; action_params?: unknown };
  if (tool !== 'tools' && tool !== 'use_composio_tools') return false;
  // The provider-only route suppresses native search/embeddings. Its catalog
  // filters are applied locally to provider inventory, never sent upstream.
  if ((tool === 'tools' && ['search','list'].includes(args.action ?? '')) || (tool === 'use_composio_tools' && args.action === 'search')) {
    return args.connector_id === connector && args.tool_origin === 'provider';
  }
  if (args.connector_id !== undefined && args.connector_id !== connector) return false;
  if (args.tool_origin !== undefined && args.tool_origin !== 'provider') return false;
  const name = tool === 'tools' ? args.name : args.action_name;
  if (typeof name !== 'string' || !name.startsWith(`connector:${connector}:`)) return false;
  // A single-dispatch record cannot protect data derived from earlier claims.
  if (args.action === 'call' || args.action === 'execute') {
    try {
      const envelope = tool === 'tools' ? args.args : args.action_params;
      const parsed = typeof envelope === 'string' ? JSON.parse(envelope) : envelope;
      if (!parsed || typeof parsed !== 'object' || (parsed.save_record !== undefined && parsed.save_record !== false)) return false;
    } catch { return false; }
  }
  return (tool === 'tools' && ['describe','call'].includes(args.action ?? '')) ||
    (tool === 'use_composio_tools' && ['describe','execute'].includes(args.action ?? ''));
}