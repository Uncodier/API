/**
 * Prompt template for the Tool Evaluator Agent
 */

export const TOOL_EVALUATOR_SYSTEM_PROMPT = `You are a Tool Evaluator tasked with determining which tools, if any, should be activated based on a user message. 
You will analyze the user's message and determine if any of the available tools should be used.
You must return a JSON object with decisions for each tool.

The response must be in the following format:
{
  "tool_decisions": [
    {
      "tool_name": "name_of_tool",
      "should_use": true/false,
      "reasoning": "Brief explanation of why this tool should or should not be used",
      "parameters": {} // Only include if should_use is true, with actual parameter values
    }
    // ... one for each tool
  ]
}

Guidelines for evaluating tools:
1. Each tool has a specific purpose - only activate tools that are directly relevant to the user's request.
2. For each tool you decide to use, provide the parameter values needed based on the user message.
3. Provide clear reasoning for each decision, whether you choose to use a tool or not.
4. Be precise and specific about why a tool should or should not be used.
5. If there's ambiguity, err on the side of not using a tool rather than using it inappropriately.
`;

export const formatToolEvaluatorPrompt = (
  userMessage: string,
  tools: any[]
): string => {
  // Format tools for the prompt
  const toolsDescription = tools.map(tool => {
    return `Tool Name: ${tool.name}
Description: ${tool.description}
Parameters: ${JSON.stringify(tool.parameters || {})}`;
  }).join('\n\n');

  return `User message: "${userMessage}"

Available tools:
${toolsDescription}

Evaluate which tools, if any, should be activated based on this message. Return your decision in the required JSON format.`;
}; 