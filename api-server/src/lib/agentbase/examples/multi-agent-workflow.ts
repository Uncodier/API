/**
 * Multi-Agent Workflow Example
 * 
 * This example demonstrates a workflow with multiple agents collaborating
 * on a task, with each agent having specific responsibilities.
 * 
 * The workflow involves:
 * 1. A Research Agent that searches for information
 * 2. An Analysis Agent that processes and analyzes the data
 * 3. A Supervisor Agent that reviews and approves the final results
 */
import {
  CommandFactory,
  CommandService,
  PortkeyAgent,
  PortkeyAgentConnector,
  PortkeyConfig,
  createSupervisionParams,
  executeWithRetry
} from '../index';

class ResearchAgent extends PortkeyAgent {
  constructor(
    id: string,
    name: string,
    connector: PortkeyAgentConnector
  ) {
    super(id, name, connector, ['research', 'data_fetch', 'search']);
  }
  
  // Override the executeTool method to implement custom research tools
  async executeTool(tool: any): Promise<any> {
    switch (tool.name) {
      case 'search':
        return this.performSearch(tool.parameters);
      case 'data_fetch':
        return this.fetchData(tool.parameters);
      default:
        return super.executeTool(tool);
    }
  }
  
  private async performSearch(params: any): Promise<any> {
    console.log(`[ResearchAgent] Performing search with query: ${params.query}`);
    // Mock search results
    return {
      results: [
        {
          title: "What is Agentbase?",
          content: "Agentbase is a framework for multiple language models to collaborate on tasks."
        },
        {
          title: "Agentbase Architecture",
          content: "The command structure is the foundation, allowing multiple agents to iteratively process data."
        },
        {
          title: "Agent Collaboration",
          content: "Agents maintain distinct memories and instructions while working on shared objects."
        }
      ],
      metadata: {
        totalResults: 3,
        searchTime: "0.23s"
      }
    };
  }
  
  private async fetchData(params: any): Promise<any> {
    console.log(`[ResearchAgent] Fetching data from: ${params.source}`);
    // Mock data fetch
    return {
      data: {
        title: "Agentbase Documentation",
        content: "Comprehensive guide to building multi-agent systems.",
        sections: ["Introduction", "Architecture", "Implementation", "Best Practices"]
      },
      source: params.source,
      timestamp: new Date().toISOString()
    };
  }
}

class AnalysisAgent extends PortkeyAgent {
  constructor(
    id: string,
    name: string,
    connector: PortkeyAgentConnector
  ) {
    super(id, name, connector, ['analysis', 'data_processing', 'summarization']);
  }
  
  // Override the executeTool method to implement custom analysis tools
  async executeTool(tool: any): Promise<any> {
    switch (tool.name) {
      case 'analyze_data':
        return this.analyzeData(tool.parameters);
      case 'text_processing':
        return this.processText(tool.parameters);
      default:
        return super.executeTool(tool);
    }
  }
  
  private async analyzeData(params: any): Promise<any> {
    console.log(`[AnalysisAgent] Analyzing data: ${JSON.stringify(params.data).substring(0, 100)}...`);
    // Mock analysis results
    return {
      analysis: {
        key_points: [
          "Agentbase enables asynchronous collaboration between language models",
          "Command structure is the foundation of the Agentbase framework",
          "Agents maintain separate memories but work on shared objects"
        ],
        sentiment: "positive",
        complexity: "medium"
      },
      metadata: {
        analysisTime: "1.2s",
        confidence: 0.89
      }
    };
  }
  
  private async processText(params: any): Promise<any> {
    console.log(`[AnalysisAgent] Processing text: ${params.text?.substring(0, 50)}...`);
    // Mock text processing
    return {
      processed: "Processed content...",
      word_count: 150,
      summary: "A brief summary of the processed text."
    };
  }
}

class SupervisorAgent extends PortkeyAgent {
  constructor(
    id: string,
    name: string,
    connector: PortkeyAgentConnector
  ) {
    super(id, name, connector, ['supervision', 'quality_control', 'review']);
  }
  
  // Override the executeTool method to implement supervisor tools
  async executeTool(tool: any): Promise<any> {
    switch (tool.name) {
      case 'review_analysis':
        return this.reviewAnalysis(tool.parameters);
      case 'quality_check':
        return this.qualityCheck(tool.parameters);
      default:
        return super.executeTool(tool);
    }
  }
  
  private async reviewAnalysis(params: any): Promise<any> {
    console.log(`[SupervisorAgent] Reviewing analysis: ${JSON.stringify(params).substring(0, 100)}...`);
    // Mock review results
    return {
      approved: true,
      score: 92,
      feedback: "The analysis is comprehensive and accurate. Key points clearly identified.",
      improvements: [
        "Consider adding more context about implementation details"
      ]
    };
  }
  
  private async qualityCheck(params: any): Promise<any> {
    console.log(`[SupervisorAgent] Quality checking results: ${JSON.stringify(params).substring(0, 100)}...`);
    // Mock quality check
    return {
      quality_score: 88,
      issues: [],
      meets_standards: true
    };
  }
}

async function runMultiAgentWorkflow() {
  console.log('Starting Multi-Agent Workflow Example');
  
  // 1. Create Portkey configuration
  const portkeyConfig: PortkeyConfig = {
    apiKey: process.env.PORTKEY_API_KEY || 'your-portkey-api-key',
    virtualKeys: {
      'anthropic': process.env.ANTHROPIC_API_KEY || 'your-anthropic-api-key',
      'openai': process.env.OPENAI_API_KEY || 'your-openai-api-key',
      'gemini': process.env.GEMINI_API_KEY || 'your-gemini-api-key'
    }
  };
  
  // 2. Create connector
  const connector = new PortkeyAgentConnector(portkeyConfig, {
    modelType: 'anthropic',
    temperature: 0.7
  });
  
  // 3. Create agents
  const researchAgent = new ResearchAgent('agent_research', 'Research Agent', connector);
  const analysisAgent = new AnalysisAgent('agent_analysis', 'Analysis Agent', connector);
  const supervisorAgent = new SupervisorAgent('agent_supervisor', 'Supervisor Agent', connector);
  
  // 4. Create a command service
  const commandService = new CommandService();
  
  // 5. Set up supervision parameters
  const supervisionParams = createSupervisionParams({
    autoApproveThreshold: 0.9,
    requireApprovalFor: ['analysis_result'],
    supervisorRoles: ['supervisor'],
    timeoutSeconds: 120
  });
  
  // 6. Create and execute the research command
  console.log('Step 1: Research - Collecting information about Agentbase');
  const researchCommand = CommandFactory.createCommand({
    task: 'Research and collect information about the Agentbase framework',
    userId: 'user_456',
    description: 'Find information about Agentbase framework capabilities and architecture',
    agentId: researchAgent.id,
    tools: [
      CommandFactory.createTool({
        name: 'search',
        description: 'Search for information',
        type: 'synchronous',
        parameters: {
          query: 'Agentbase framework capabilities architecture',
          max_results: 5
        }
      }),
      CommandFactory.createTool({
        name: 'data_fetch',
        description: 'Fetch detailed data',
        type: 'synchronous',
        parameters: {
          source: 'documentation',
          section: 'architecture'
        }
      })
    ],
    executionOrder: ['search', 'data_fetch']
  });
  
  const researchCommandId = await commandService.submitCommand(researchCommand);
  console.log(`Submitted research command with ID: ${researchCommandId}`);
  
  // Get and execute the research command
  const dbResearchCommand = await commandService.getCommandById(researchCommandId);
  if (!dbResearchCommand) {
    throw new Error('Failed to retrieve research command');
  }
  
  await commandService.updateStatus(researchCommandId, 'running');
  const researchResult = await executeWithRetry(() => 
    researchAgent.executeCommand(dbResearchCommand)
  );
  
  await commandService.updateCommand(researchCommandId, {
    status: researchResult.status,
    results: researchResult.results
  });
  
  console.log('Research Results:', JSON.stringify(researchResult.results, null, 2));
  
  // 7. Create and execute the analysis command using research results
  console.log('\nStep 2: Analysis - Processing the collected information');
  const analysisCommand = CommandFactory.createCommand({
    task: 'Analyze the research information about Agentbase and identify key insights',
    userId: 'user_456',
    description: 'Process and analyze the research findings',
    agentId: analysisAgent.id,
    context: JSON.stringify(researchResult.results),
    tools: [
      CommandFactory.createTool({
        name: 'analyze_data',
        description: 'Analyze the research data',
        type: 'synchronous',
        parameters: {
          data: researchResult.results,
          analysis_type: 'comprehensive'
        }
      }),
      CommandFactory.createTool({
        name: 'text_processing',
        description: 'Process text content',
        type: 'synchronous',
        parameters: {
          text: JSON.stringify(researchResult.results),
          operation: 'summarize'
        }
      })
    ],
    executionOrder: ['analyze_data', 'text_processing'],
    supervisionParams
  });
  
  const analysisCommandId = await commandService.submitCommand(analysisCommand);
  console.log(`Submitted analysis command with ID: ${analysisCommandId}`);
  
  // Get and execute the analysis command
  const dbAnalysisCommand = await commandService.getCommandById(analysisCommandId);
  if (!dbAnalysisCommand) {
    throw new Error('Failed to retrieve analysis command');
  }
  
  await commandService.updateStatus(analysisCommandId, 'running');
  const analysisResult = await executeWithRetry(() => 
    analysisAgent.executeCommand(dbAnalysisCommand)
  );
  
  await commandService.updateCommand(analysisCommandId, {
    status: analysisResult.status,
    results: analysisResult.results
  });
  
  console.log('Analysis Results:', JSON.stringify(analysisResult.results, null, 2));
  
  // 8. If supervision is required, create a supervision command
  if (analysisResult.status === 'pending_supervision' && analysisResult.supervisionRequestId) {
    console.log('\nStep 3: Supervision - Reviewing the analysis results');
    const supervisionCommand = CommandFactory.createCommand({
      task: 'Review and approve the analysis results',
      userId: 'user_456',
      description: 'Ensure quality and accuracy of the analysis',
      agentId: supervisorAgent.id,
      context: JSON.stringify({
        analysisResults: analysisResult.results,
        researchData: researchResult.results
      }),
      tools: [
        CommandFactory.createTool({
          name: 'review_analysis',
          description: 'Review the analysis results',
          type: 'synchronous',
          parameters: {
            analysis: analysisResult.results,
            criteria: ['accuracy', 'completeness', 'clarity']
          }
        }),
        CommandFactory.createTool({
          name: 'quality_check',
          description: 'Check quality of results',
          type: 'synchronous',
          parameters: {
            results: analysisResult.results,
            standards: ['high_quality', 'actionable']
          }
        })
      ],
      executionOrder: ['review_analysis', 'quality_check'],
      priority: 8
    });
    
    const supervisionCommandId = await commandService.submitCommand(supervisionCommand);
    console.log(`Submitted supervision command with ID: ${supervisionCommandId}`);
    
    // Get and execute the supervision command
    const dbSupervisionCommand = await commandService.getCommandById(supervisionCommandId);
    if (!dbSupervisionCommand) {
      throw new Error('Failed to retrieve supervision command');
    }
    
    await commandService.updateStatus(supervisionCommandId, 'running');
    const supervisionResult = await executeWithRetry(() => 
      supervisorAgent.executeCommand(dbSupervisionCommand)
    );
    
    await commandService.updateCommand(supervisionCommandId, {
      status: supervisionResult.status,
      results: supervisionResult.results
    });
    
    console.log('Supervision Results:', JSON.stringify(supervisionResult.results, null, 2));
    
    // Update the analysis command based on supervision results
    const approvalStatus = supervisionResult.results?.find(r => r.type === 'review_analysis')?.content?.approved;
    
    if (approvalStatus) {
      console.log('\nAnalysis was approved by the supervisor');
      await commandService.updateStatus(analysisCommandId, 'completed');
    } else {
      console.log('\nAnalysis was rejected by the supervisor');
      await commandService.updateStatus(analysisCommandId, 'failed');
    }
  }
  
  // 9. Final results summary
  console.log('\nWorkflow Complete');
  console.log('Research Status:', (await commandService.getCommandById(researchCommandId))?.status);
  console.log('Analysis Status:', (await commandService.getCommandById(analysisCommandId))?.status);
  
  return {
    research: researchResult,
    analysis: analysisResult
  };
}

// Uncomment to run the example
// runMultiAgentWorkflow().catch(console.error);

export { runMultiAgentWorkflow }; 