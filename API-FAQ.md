# FAQ - Uncodie API

Frequently asked questions about Uncodie's AI team communication and system events API.

## General Questions

**Question:** What is the Uncodie API?
**Answer:** The Uncodie API allows you to programmatically communicate with your AI team and manage the main system events. Build seamless integrations to orchestrate AI workflows, handle team coordination, and monitor system activities through well-documented REST endpoints.

**Question:** What AI team capabilities does the API support?
**Answer:** The API supports multiple AI team interactions including Claude 3.5 Sonnet (Anthropic), GPT-4 (OpenAI), and Gemini 1.5 (Google) agents. You can coordinate tasks, manage conversations, and handle multi-agent workflows programmatically.

**Question:** What are the API usage limits?
**Answer:** Limits vary by plan: Free (1000 requests/month), Startup (10000 requests/month), Enterprise (custom volume). The basic rate limit is up to 100 requests per minute for AI team operations.

**Question:** Does the API support real-time team communication?
**Answer:** Yes, the API supports WebSocket for real-time AI team communication and system event streaming through the `wss://api.uncodie.com/v1/team/stream` endpoint.

## Authentication and Security

**Question:** How do I authenticate with the API?
**Answer:** Use your API key in the `X-API-Key` header or `Authorization: Bearer your-api-key`. You can get your API key from the Uncodie dashboard.

**Question:** What format do API keys have?
**Answer:** API keys follow the format `[prefix]_[random_part]` where prefix is an identifier (e.g., prod, dev) and random_part is a cryptographically secure string with 256 bits of entropy.

**Question:** Do API keys expire?
**Answer:** Yes, API keys have automatic rotation after a configurable period (default 90 days). They also include usage limits and can be immediately revoked if needed.

**Question:** What scopes exist for API keys?
**Answer:** The main scopes are 'read' (for querying data) and 'write' (for creating/modifying data). Each endpoint requires specific scopes for access.

## AI Team Communication & System Events

**Question:** What are the main API endpoints?
**Answer:** The main endpoints include: `/api/agents` (AI team management), `/api/conversation` (team chat coordination), `/api/workflow` (multi-agent workflows), `/api/status` (system events), `/api/teamMembers` (team member management), and `/api/ai` (direct AI communication).

**Question:** How do I communicate with specific AI team members?
**Answer:** Use `/api/agents/{agent_type}/command/{command_name}` to send specific commands to AI agents. Available agent types include sales, copywriter, and analyst agents. Each supports different command patterns for task coordination.

**Question:** Can I monitor system events in real-time?
**Answer:** Yes, use `/api/status` for current system status and WebSocket connections for real-time event streaming. The API provides detailed system health, workflow states, and team activity monitoring.

**Question:** What types of AI workflows are available?
**Answer:** Available workflows include: team coordination (buildSegments), content generation (buildContent), lead management (leadGeneration, leadFollowUp), campaign orchestration (buildCampaigns), and research workflows (leadResearch).

## Team Configuration & Workflow Parameters

**Question:** How do I configure AI team member behavior?
**Answer:** Use parameters like `modelType`, `modelId`, and `provider` in team communication endpoints. You can specify different AI models (anthropic, openai, gemini) and configure timeout values between 5,000ms and 120,000ms for workflow execution.

**Question:** What's the default timeout for AI team operations?
**Answer:** The default timeout is 30,000ms (30 seconds) for individual AI responses, but workflow operations can be configured between 5,000ms and 120,000ms based on complexity and team coordination requirements.

**Question:** Can I customize team member roles and permissions?
**Answer:** Yes, through `/api/teamMembers` you can manage roles like 'view', 'create', 'delete', and 'admin'. Each role has specific scopes for interacting with different AI agents and system events.

**Question:** How do I control workflow execution depth?
**Answer:** Use parameters like `site_id`, `segment_id`, and `mode` to control how deep AI workflows execute. The `mode` parameter supports 'analyze', 'create', and 'update' operations for different workflow behaviors.

## AI Team Responses & Event Formats

**Question:** In what format does the API return team communication responses?
**Answer:** All AI team responses are in clean JSON format with standard structure including `success`, `data`/`result`, team member identification, workflow status, and system event details when applicable.

**Question:** Can I request responses in specific format from AI team members?
**Answer:** Yes, endpoints like `/api/conversation` and `/api/agents` support the `responseFormat` parameter to request structured JSON, markdown, or custom formats from specific AI team members.

**Question:** What information do system events include?
**Answer:** System events include: event type, timestamp, affected team members, workflow states, command status, and detailed metadata about AI operations and team coordination activities.

**Question:** How are workflow execution results structured?
**Answer:** Workflow results include execution status, participating AI agents, task completion details, generated outputs, and coordination metadata with timestamps for each step in the multi-agent process.

## Advanced AI Team Operations

**Question:** How do AI team members collaborate on complex tasks?
**Answer:** AI agents collaborate through multi-agent workflows where each team member contributes specialized expertise. The system coordinates tasks automatically, managing dependencies and ensuring proper information flow between team members.

**Question:** How does AI team lead management work?
**Answer:** The sales AI agents handle lead generation, research, and follow-up workflows. Use `/api/workflow/leadGeneration` and `/api/workflow/leadFollowUp` to programmatically manage lead processes with intelligent automation and team coordination.

**Question:** Can I create custom AI team workflows?
**Answer:** Yes, using workflow endpoints with `mode: "create"` and `mode: "update"` parameters, you can orchestrate custom multi-agent processes. The API supports buildSegments, buildContent, buildCampaigns, and custom workflow combinations.

**Question:** What AI team metrics and analytics are available?
**Answer:** Team metrics include: workflow completion rates, AI response times, team member utilization, task success rates, system event frequencies, and collaboration efficiency measurements.

## System Integration & Event Management

**Question:** Does the API support automated AI team workflows?
**Answer:** Yes, the API includes comprehensive workflow endpoints like `/api/workflow/buildSegments`, `/api/workflow/buildCampaigns`, `/api/workflow/buildContent`, and `/api/workflow/leadGeneration` for orchestrating complex multi-agent processes and system automation.

**Question:** How can I integrate AI team communication into my application?
**Answer:** Use fetch() or your HTTP client to communicate with AI team members. Example: `fetch('/api/agents/sales/command/leadGeneration', { method: 'POST', headers: {'X-API-Key': 'your-key'}, body: JSON.stringify({site_id: 'site_123', parameters: {...}}) })`

**Question:** Is there interactive documentation for AI team operations?
**Answer:** Yes, visit `/api/docs` to access interactive documentation where you can test AI team endpoints, see workflow examples, monitor system events, and execute team coordination requests in real time.

## AI Team Communication Errors & System Events

**Question:** What error codes does the API return for team operations?
**Answer:** Main codes are: 200 (OK), 201 (Created), 400 (Bad Request), 401 (Unauthorized), 403 (Forbidden), 404 (Not Found), 429 (Too Many Requests), 500 (Internal Server Error), 503 (Service Unavailable). Additional team-specific codes include agent unavailable, workflow timeout, and coordination errors.

**Question:** What do I do if I receive error 429 during AI team operations?
**Answer:** Wait for the time indicated in the `retryAfter` header before trying again. AI team operations may have different rate limits per agent type. Implement exponential backoff and consider distributing workload across multiple team members.

**Question:** What does "Agent unavailable" error mean?
**Answer:** This indicates the specified AI team member is currently busy with other tasks or temporarily offline. Check `/api/status` for team member availability and consider using alternative agents or queueing the request.

**Question:** How do I handle workflow timeout errors?
**Answer:** Increase timeout values for complex multi-agent workflows, break down large tasks into smaller workflow steps, or monitor workflow progress using system events to identify bottlenecks in team coordination.

**Question:** What do I do if a workflow fails to execute?
**Answer:** Check system events via `/api/status`, verify that all required team members are available, ensure proper parameters are provided, and review workflow dependencies. The error will include details about which step or agent caused the failure.

## Plans and Billing

**Question:** How much does it cost to use the API?
**Answer:** Offers Free plan (1000 requests/month), Pro (10000 requests/month), and Enterprise (custom volume). Visit /pricing for updated details.

**Question:** How do I monitor my API usage?
**Answer:** Access your dashboard at https://uncodie.com/dashboard to see usage statistics, limits, and manage your API keys.

**Question:** Can I increase my limits?
**Answer:** Yes, contact support to increase limits or consider upgrading to a higher plan based on your needs.

## AI Team Support & System Resources

**Question:** Where can I get help with AI team operations?
**Answer:** Use the dashboard (https://uncodie.com/dashboard) for team management, documentation (/docs) for workflows, check system status (https://status.uncodie.com) for AI team availability, or consult the GitHub repository for integration examples.

**Question:** Is there a playground to test AI team communication?
**Answer:** Yes, visit the interactive documentation at `/api/docs` which includes a complete playground to test team coordination endpoints, execute workflows, monitor system events, and simulate multi-agent operations in real-time.

**Question:** Are AI team members available 24/7?
**Answer:** Yes, we continuously monitor AI team availability and system status. You can check current team member status and system events at https://status.uncodie.com for real-time operational information.

**Question:** How do I report AI team coordination issues or system events?
**Answer:** Contact support through the dashboard for team-related issues, use `/api/status` to monitor system events programmatically, or report technical problems in the GitHub repository with specific workflow details and team coordination logs. 