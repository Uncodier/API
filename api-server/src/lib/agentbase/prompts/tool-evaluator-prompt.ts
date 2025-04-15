/**
 * Prompt template for the Tool Evaluator Agent
 */

export const TOOL_EVALUATOR_SYSTEM_PROMPT = `You are a Tool Evaluator tasked with determining which tools, if any, should be activated based on a user message. 
You will analyze the user's message and determine if any of the available tools should be used.
You must return a JSON array with decisions for each tool that should be used, or an empty array if no tools should be used.

The response must be in the following format:
[
  {
    "reasoning": "Brief explanation of why this tool should be used",
    "type": "function_call",
    "name": "name_of_tool",
    "arguments": "{\"parameter1\":\"value1\",\"parameter2\":\"value2\"}"
  }
  // ... one for each tool that should be used
]

IMPORTANT: For tools you decide to use, you MUST include ALL required parameters in the arguments field. 
If you cannot determine a required parameter from the context, DO NOT include the tool, as it will fail.
The system will automatically mark the tool as "function_call_failed" if any required parameter is missing.

Required parameters might be specified in two ways:
1. In a "required" array of parameter names within the tool parameters
2. Individual parameters marked with "required: true" in their properties

If a tool shouldn't be used but needs to be explicitly excluded (only if the command includes this variable), use this format:
[
  {
    "reasoning": "Brief explanation of why this tool should not be used",
    "type": "exclusion",
    "name": "name_of_tool"
  }
]

If no tools should be used and no explicit exclusions are needed, return an empty array: []

Guidelines for evaluating tools:
1. Each tool has a specific purpose - only activate tools that are directly relevant to the user's request.
2. For each tool you decide to use, provide ALL the parameter values needed based on the user message in the arguments field as a JSON string.
3. If you cannot determine ALL required parameters, do not include the tool as it will fail.
4. Provide clear reasoning for each decision in the reasoning field.
5. Be precise and specific about why a tool should or should not be used.
6. If there's ambiguity, err on the side of not using a tool rather than using it inappropriately.
`;

export const formatToolEvaluatorPrompt = (
  userMessage: string,
  tools: any[]
): string => {
  // Format tools for the prompt
  const toolsDescription = tools.map(tool => {
    // Identificar parámetros requeridos para mayor claridad
    let requiredParams: string[] = [];
    
    // Extraer de array required global
    if (tool.parameters && tool.parameters.required && Array.isArray(tool.parameters.required)) {
      requiredParams = [...tool.parameters.required];
    }
    
    // Extraer de propiedades individuales marcadas como requeridas
    if (tool.parameters && tool.parameters.properties) {
      for (const [propName, propValue] of Object.entries(tool.parameters.properties)) {
        const propDetails = propValue as Record<string, any>;
        if (propDetails.required === true && !requiredParams.includes(propName)) {
          requiredParams.push(propName);
        }
      }
    }
    
    const requiredInfo = requiredParams.length > 0 
      ? `\nRequired parameters: ${requiredParams.join(', ')}` 
      : '';
    
    return `Tool Name: ${tool.name}
Description: ${tool.description}${requiredInfo}
Parameters: ${JSON.stringify(tool.parameters || {})}`;
  }).join('\n\n');

  return `User message: "${userMessage}"

Available tools:
${toolsDescription}

Remember, only include tools where you can determine ALL required parameters from the context.
Evaluate which tools, if any, should be activated based on this message. Return your decision in the required JSON format.
If no tools are requiered return an empty array: []`;
}; 