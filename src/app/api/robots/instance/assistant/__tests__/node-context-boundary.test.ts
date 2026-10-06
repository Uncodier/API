import { assertNodeContextHasNode, isNodeSpecificContext } from '../node-context-boundary';

describe('confirmed node context boundary', () => {
  it.each([
    { nodeType: 'publish' },
    { nodeType: 'generate-audience' },
    { instance_node_id: 'embedded-node' },
    { instanceNodeId: 'embedded-node' },
    { publish_destinations: [] },
    { publish_destinations: ['tiktok'] },
    { ui_contract: { version: 1, output_type: 'video' } },
  ])('requires explicit identity, never inferred from context: %j', context => {
    const serialized = JSON.stringify(context);
    expect(isNodeSpecificContext(serialized)).toBe(true);
    for (const nodeId of [undefined, '', '   ']) {
      expect(() => assertNodeContextHasNode(serialized, nodeId)).toThrow('NODE_CONTEXT_REQUIRES_NODE');
    }
    expect(() => assertNodeContextHasNode(serialized, 'explicit-node')).not.toThrow();
  });

  it.each(['nodeType', 'mediaType', 'media_type', 'output_type'])('recognizes supported %s selectors', key => {
    for (const value of ['image', 'video', 'audio', 'text', 'prompt', 'response', 'audience', 'publish',
      'generate-image', 'generate-video', 'generate-audio', 'generate-audience', ' GENERATE_IMAGE ']) {
      const serialized = JSON.stringify({ [key]: value });
      expect(isNodeSpecificContext(serialized)).toBe(true);
      expect(() => assertNodeContextHasNode(serialized)).toThrow('NODE_CONTEXT_REQUIRES_NODE');
    }
  });

  it.each([
    undefined, '', 'Please describe this image and explain publish nodes.',
    'null', 'true', '17', '"publish"', '[]', '{"nodeType":',
    JSON.stringify({ note: 'nodeType: publish', parameters: { duration: 8 } }),
    JSON.stringify({ mediaType: 'application/pdf', output_type: 'json' }),
    JSON.stringify({ nodeType: '', media_type: null, publish_destinations: 'tiktok' }),
    JSON.stringify({ records: [{ nodeType: 'publish' }], attachments: [{ media_type: 'image' }] }),
    JSON.stringify([{ nodeType: 'publish' }]),
  ])('does not classify ordinary or unconfirmed context as node execution: %s', context => {
    expect(isNodeSpecificContext(context)).toBe(false);
    expect(() => assertNodeContextHasNode(context)).not.toThrow();
  });
});