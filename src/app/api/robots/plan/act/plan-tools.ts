import type { Tool } from '@/lib/custom-automation/ai-agent-executor';

/** Keep SDK schemas and real execute closures, including their remote-call retries. */
export function adaptPlanTools(tools: Tool[]): Tool[] {
  return tools.map(tool => {
    if (!tool.name || !tool.parameters || typeof tool.execute !== 'function') {
      throw new Error('Plan execution requires a named tool with parameters and an executor');
    }
    const parameters = tool.parameters;
    return {
      name: tool.name,
      description: tool.description,
      parameters,
      execute: async args => tool.execute(
        typeof parameters.parseAsync === 'function' ? await parameters.parseAsync(args) : args,
      ),
    };
  });
}