import { normalizePhoneForStorage } from '@/lib/utils/phone-normalizer';
import { assistantConnectorContext, type ConnectorContextResolver } from '@/lib/connectors/host-context';
import { readToolExecutionContext, type ToolExecutionContext } from '@/lib/services/tool-execution-context';
import { hasInstanceHistoryScope } from '@/lib/services/robot-instance/instance-history-reader';

// Tool imports
import { generateImageTool } from '@/app/api/agents/tools/generateImage/assistantProtocol';
import { generateVideoTool } from '@/app/api/agents/tools/generateVideo/assistantProtocol';
import { generateAudioTool } from '@/app/api/agents/tools/generateAudio/assistantProtocol';
import { instanceTool } from '@/app/api/agents/tools/instance/assistantProtocol';
import { updateSiteSettingsTool } from '@/app/api/agents/tools/updateSiteSettings/assistantProtocol';
import { webSearchTool } from '@/app/api/agents/tools/webSearch/assistantProtocol';
import {
  routeTools,
  type RoutedTool,
} from '@/app/api/agents/tools/router/assistantProtocol';
import { skillLookupTool } from '@/app/api/agents/tools/sandbox/skill-lookup-tool';
import { externalSkillLookupTool } from '@/app/api/agents/tools/sandbox/external-skill-lookup-tool';
import { memoriesTool } from '@/app/api/agents/tools/memories/assistantProtocol';
import { tasksTool } from '@/app/api/agents/tools/tasks/assistantProtocol';
import { requirementsTool } from '@/app/api/agents/tools/requirements/assistantProtocol';
import type { RequirementCommandSource } from '@/lib/services/requirement-command';
import { assertStandaloneCommandPlan } from './command-plan-guard';
import { leadsTool } from '@/app/api/agents/tools/leads/assistantProtocol';
import { leadBulkOperationsTool } from '@/app/api/agents/tools/leads_bulk_operations/assistantProtocol';
import { catalogCommerceTool } from '@/app/api/agents/tools/catalog_commerce/assistantProtocol';
import { reservationSchedulesTool } from '@/app/api/agents/tools/reservation_schedules/assistantProtocol';
import { calendarBlocksTool } from '@/app/api/agents/tools/calendar_blocks/assistantProtocol';
import { calendarsTool } from '@/app/api/agents/tools/calendars/assistantProtocol';
import { reservationsTool } from '@/app/api/agents/tools/reservations/assistantProtocol';
import { checkoutTool } from '@/app/api/agents/tools/checkout/assistantProtocol';
import { entitlementsTool } from '@/app/api/agents/tools/entitlements/assistantProtocol';
import { quotationItemsTool } from '@/app/api/agents/tools/quotation_items/assistantProtocol';
import { quotationsTool } from '@/app/api/agents/tools/quotations/assistantProtocol';
import { purchasesTool } from '@/app/api/agents/tools/purchases/assistantProtocol';
import { purchaseItemsTool } from '@/app/api/agents/tools/purchase_items/assistantProtocol';
import { createProcurementTools } from '@/lib/procurement/tools';
import { subscriptionPlanItemsTool } from '@/app/api/agents/tools/subscription_plan_items/assistantProtocol';
import { subscriptionsTool } from '@/app/api/agents/tools/subscriptions/assistantProtocol';
import { contentTool } from '@/app/api/agents/tools/content/assistantProtocol';
import { sendEmailTool } from '@/app/api/agents/tools/sendEmail/assistantProtocol';
import { configureEmailTool } from '@/app/api/agents/tools/configureEmail/assistantProtocol';
import { configureWhatsAppTool } from '@/app/api/agents/tools/configureWhatsApp/assistantProtocol';
import { salesOrderTool } from '@/app/api/agents/tools/sales-order/assistantProtocol';
import { salesTool } from '@/app/api/agents/tools/sales/assistantProtocol';
import { dealsTool } from '@/app/api/agents/tools/deals/assistantProtocol';
import { schedulingTool } from '@/app/api/agents/tools/scheduling/assistantProtocol';
import { analyzeICPTotalCountTool } from '@/app/api/agents/tools/analyzeICPTotalCount/assistantProtocol';
import { createIcpMiningTool } from '@/app/api/agents/tools/createIcpMining/assistantProtocol';
import { getFinderCategoryIdsTool } from '@/app/api/agents/tools/getFinderCategoryIds/assistantProtocol';
import { searchRegionVenuesTool } from '@/app/api/agents/tools/searchRegionVenues/assistantProtocol';
import { webhooksTool } from '@/app/api/agents/tools/webhooks/assistantProtocol';
import { categoriesTool } from '@/app/api/agents/tools/categories/assistantProtocol';
import { urlToMarkdownTool } from '@/app/api/agents/tools/urlToMarkdown/assistantProtocol';
import { urlToSitemapTool } from '@/app/api/agents/tools/urlToSitemap/assistantProtocol';
import { segmentsTool } from '@/app/api/agents/tools/segments/assistantProtocol';
import { campaignsTool } from '@/app/api/agents/tools/campaigns/assistantProtocol';
import { promotionsTool } from '@/app/api/agents/tools/promotions/assistantProtocol';
import { assetsTool } from '@/app/api/agents/tools/assets/assistantProtocol';
import { instancePlanTool } from '@/app/api/agents/tools/instance_plan/assistantProtocol';
import { recordCategoryTool } from '@/app/api/agents/tools/record_category/assistantProtocol';
import { recordTool } from '@/app/api/agents/tools/record/assistantProtocol';
import { workflowsTool } from '@/app/api/agents/tools/workflows/assistantProtocol';
import { copywritingTool } from '@/app/api/agents/tools/copywriting/assistantProtocol';
import { sendWhatsAppTool } from '@/app/api/agents/tools/sendWhatsApp/assistantProtocol';
import { sendChannelMessageTool } from '@/app/api/agents/tools/sendChannelMessage/assistantProtocol';
import { whatsappTemplateTool } from '@/app/api/agents/tools/whatsappTemplate/assistantProtocol';
import { conversationsTool } from '@/app/api/agents/tools/conversations/assistantProtocol';
import { messagesTool } from '@/app/api/agents/tools/messages/assistantProtocol';
import { reportTool } from '@/app/api/agents/tools/report/assistantProtocol';
import { createAccountTool, verifyAccountTool } from '@/app/api/agents/gear/whatsapp/tools';
import { instanceProjectTool } from '@/app/api/agents/tools/instance_project/assistantProtocol';
import { createProjectTool } from '@/app/api/agents/tools/createProject/assistantProtocol';
import { companiesTool } from '@/app/api/agents/tools/companies/assistantProtocol';
import { systemNotificationTool } from '@/app/api/agents/tools/system_notification/assistantProtocol';
import { requirementStatusTool } from '@/app/api/agents/tools/requirement_status/assistantProtocol';
import { requirementBacklogTool } from '@/app/api/agents/tools/requirement_backlog/assistantProtocol';
import { createHarnessDiagnosticTools, refreshHarnessToolManifest } from '@/lib/services/harness-diagnostics/tools';
import { instanceLogsTool } from '@/app/api/agents/tools/instance_logs/assistantProtocol';
import { instanceHistoryTool } from '@/app/api/agents/tools/instance_history/assistantProtocol';
import { audioToTextTool } from '@/app/api/agents/tools/audioToText/assistantProtocol';
import { analyzeVideoTool } from '@/app/api/agents/tools/analyzeVideo/assistantProtocol';
import { transactionsTool } from '@/app/api/agents/tools/transactions/assistantProtocol';
import { createSecretTool } from '@/app/api/agents/tools/createSecret/assistantProtocol';
import { listSiteSecretsTool } from '@/app/api/agents/tools/listSiteSecrets/assistantProtocol';
import { integrationApiRequestTool } from '@/app/api/agents/tools/integration_api_request/assistantProtocol';
import { socialMediaAccountsTool } from '@/app/api/agents/tools/socialMediaAccounts/assistantProtocol';
import { socialMediaPostsTool } from '@/app/api/agents/tools/socialMediaPosts/assistantProtocol';
import { socialMediaAnalyticsTool } from '@/app/api/agents/tools/socialMediaAnalytics/assistantProtocol';
import { audienceTool } from '@/app/api/agents/tools/audience/assistantProtocol';
import { sendBulkMessagesTool } from '@/app/api/agents/tools/sendBulkMessages/assistantProtocol';
import { publishTool } from '@/app/api/agents/tools/publish/assistantProtocol';
import { placeVoiceCallTool } from '@/app/api/agents/tools/placeVoiceCall/assistantProtocol';
import { activateCodingAgentsTool } from '@/app/api/agents/tools/activate_coding_agents/assistantProtocol';
import { updateRepoTool } from '@/app/api/agents/tools/update_repo/assistantProtocol';
import { showArtifactTool } from '@/app/api/agents/tools/show_artifact/assistantProtocol';
import { composioActionTool } from '@/app/api/agents/tools/composio/assistantProtocol';
import { readDocumentTool } from '@/app/api/agents/tools/read_document/assistantProtocol';
import type { UiMediaOutputType } from './ui-media-contract';
import { deliverFileTool } from './deliver-file-tool';

/**
 * Helper to get all assistant tools including custom ones
 */
export const getAssistantToolDefinitions = (
  siteId: string,
  userId: string | undefined,
  instanceId: string,
  customTools: any[] = [],
  agentType?: string,
  userPhone?: string,
  requirementId?: string,
  uiMediaOutputType?: UiMediaOutputType,
  approvedImport?: { url: string; sha256: string; userId: string },
  executionContext?: ToolExecutionContext,
  commandSource?: RequirementCommandSource,
  connectorContext?: ConnectorContextResolver,
) => {
  const allowedMediaTool = uiMediaOutputType === 'image'
    ? 'generate_image'
    : uiMediaOutputType === 'video'
      ? 'generate_video'
      : uiMediaOutputType === 'audio'
        ? 'generate_audio'
        : null;
  const mediaToolNames = new Set(['generate_image', 'generate_video', 'generate_audio']);
  const filteredCustomTools = uiMediaOutputType
    ? customTools.filter((customTool) =>
        !mediaToolNames.has(customTool?.name) || customTool.name === allowedMediaTool)
    : customTools;
  const mediaTools = [
    generateImageTool(siteId, instanceId),
    generateVideoTool(siteId, instanceId),
    generateAudioTool(siteId, instanceId, {
      forceWhatsAppCompatible: agentType === 'gear' && !userPhone?.includes('@'),
    }),
  ].filter((mediaTool) => {
    if (!uiMediaOutputType) return true;
    if (uiMediaOutputType === 'image') return mediaTool.name === 'generate_image';
    if (uiMediaOutputType === 'video') return mediaTool.name === 'generate_video';
    if (uiMediaOutputType === 'audio') return mediaTool.name === 'generate_audio';
    return false;
  });

  const tools = [
    ...filteredCustomTools,
    ...mediaTools,
    instanceTool(siteId, instanceId, userId),
    updateSiteSettingsTool(siteId),
    webSearchTool(siteId),
    memoriesTool(siteId, userId ?? '', instanceId),
    tasksTool(siteId, userId),
    requirementsTool(siteId, userId, instanceId, commandSource),
    leadsTool(siteId, userId),
    contentTool(siteId, userId),
    sendEmailTool(siteId, instanceId),
    configureEmailTool(siteId),
    configureWhatsAppTool(siteId),
    salesOrderTool(siteId),
    salesTool(siteId),
    dealsTool(siteId),
    catalogCommerceTool(siteId),
    promotionsTool(siteId, userId),
    reservationSchedulesTool(siteId),
    calendarBlocksTool(siteId),
    calendarsTool(siteId),
    reservationsTool(siteId),
    checkoutTool(siteId),
    entitlementsTool(siteId),
    quotationsTool(siteId),
    quotationItemsTool(siteId),
    purchasesTool(siteId),
    purchaseItemsTool(siteId),
    ...createProcurementTools({ siteId, userId }),
    subscriptionPlanItemsTool(siteId),
    subscriptionsTool(siteId),
    schedulingTool(siteId, instanceId),
    getFinderCategoryIdsTool(siteId),
    analyzeICPTotalCountTool(siteId),
    createIcpMiningTool(siteId),
    searchRegionVenuesTool(siteId),
    webhooksTool(),
    urlToMarkdownTool(),
    urlToSitemapTool(),
    segmentsTool(siteId, userId),
    campaignsTool(siteId, userId),
    assetsTool(siteId, userId),
    categoriesTool(siteId, userId),
    instancePlanTool(siteId, instanceId, userId, requirementId),
    recordCategoryTool(siteId),
    recordTool(siteId),
    workflowsTool(siteId, userId),
    copywritingTool(siteId, userId),
    sendWhatsAppTool(siteId),
    sendChannelMessageTool(siteId),
    whatsappTemplateTool(siteId),
    conversationsTool(siteId, userId),
    messagesTool(siteId),
    reportTool(siteId, userId ?? ''),
    systemNotificationTool(siteId),
    requirementStatusTool(siteId, instanceId, { readOnly: Boolean(commandSource) }),
    requirementBacklogTool(siteId),
    companiesTool(),
    instanceLogsTool(siteId, userId ?? '', instanceId),
    // MCP's legacy "default" and schema-only catalogs have no real instance.
    // Do not construct a reader (or broaden its scope) in those contexts.
    ...(hasInstanceHistoryScope(siteId, instanceId) ? [instanceHistoryTool(siteId, instanceId, userId)] : []),
    transactionsTool(siteId, userId ?? ''),
    createProjectTool(userId ?? ''),
    audioToTextTool(siteId),
    analyzeVideoTool(siteId, instanceId),
    createSecretTool(siteId),
    listSiteSecretsTool(siteId, instanceId),
    integrationApiRequestTool(siteId, instanceId),
    socialMediaAccountsTool(siteId),
    socialMediaPostsTool(siteId),
    socialMediaAnalyticsTool(siteId),
    audienceTool(siteId, userId ?? '', instanceId),
    sendBulkMessagesTool(siteId),
    placeVoiceCallTool(siteId, userId),
    publishTool(siteId, userId ?? '', instanceId),
    skillLookupTool({ siteId, connectorContext }),
    externalSkillLookupTool(siteId, approvedImport?.userId, approvedImport),
    activateCodingAgentsTool(siteId, instanceId, commandSource),
    updateRepoTool(siteId, instanceId, userId),
    showArtifactTool(siteId, instanceId, userId ?? ''),
    readDocumentTool(),
    deliverFileTool(siteId, userId, instanceId, requirementId),
  ];

  if (agentType === 'gear') {
    let normalizedPhone: string | undefined = undefined;
    if (userPhone) {
      if (userPhone.includes('@')) {
        normalizedPhone = userPhone;
      } else {
        normalizedPhone = normalizePhoneForStorage(userPhone) || userPhone;
      }
    }
    tools.push(
      instanceProjectTool(userId ?? '', normalizedPhone),
      createAccountTool(),
      verifyAccountTool()
    );
  }

  if (requirementId) {
    const diagnosticContext = {
      siteId, instanceId, requirementId, userId,
      runtime: customTools.some(tool => tool?.name?.startsWith('sandbox_')) ? 'sandbox_executor' : 'assistant',
      toolNames: tools.map(tool => tool.name),
    };
    const diagnostics = createHarnessDiagnosticTools(diagnosticContext);
    diagnosticContext.toolNames.push(...diagnostics.map(tool => tool.name));
    tools.push(...diagnostics);
  }

  const privateContext = readToolExecutionContext(executionContext, siteId);
  const commandTools = commandSource ? tools.map(tool => ({
    ...tool,
    execute: async (args: any, ...context: any[]) => {
      // Interactive sessions submit intent; cron remains the only requirement
      // executor. Keep standalone plans and all read-only inspection available.
      if (tool.name === 'update_repo' ||
          (tool.name === 'requirement_backlog' && !['list', 'get'].includes(args?.action)) ||
          (tool.name === 'requirement_status' && (args?.action ?? 'list') !== 'list') ||
          (tool.name === 'instance_plan' && (requirementId || args?.requirement_id) && args?.action !== 'list')) {
        throw new Error('Submit requirement changes with requirements action="update". This conversation cannot start or mutate the requirement runner; queued changes execute on its sole owner.');
      }
      if (tool.name === 'instance_plan') await assertStandaloneCommandPlan(args, siteId, instanceId, requirementId);
      return (tool.execute as (...values: any[]) => any)(args, ...context);
    },
  })) : tools;
  // Decorate BEFORE routeTools closes over the definitions. Keep private context
  // out of schemas, enumerable metadata, model arguments, and tool-call logs.
  return (privateContext ? commandTools.map((tool) => ({
    ...tool,
    execute: (args: any) => tool.execute(args, readToolExecutionContext(privateContext, siteId)),
  })) : commandTools) as RoutedTool[];
};

export const getAssistantTools = (
  siteId: string,
  userId: string | undefined,
  instanceId: string,
  customTools: any[] = [],
  agentType?: string,
  userPhone?: string,
  requirementId?: string,
  uiMediaOutputType?: UiMediaOutputType,
  approvedImport?: { url: string; sha256: string; userId: string },
  executionContext?: ToolExecutionContext,
  commandSource?: RequirementCommandSource,
  decorateHostTools?: (tools: RoutedTool[]) => RoutedTool[],
  connectorContext?: ConnectorContextResolver,
) => {
  const definitions = getAssistantToolDefinitions(siteId, userId, instanceId, customTools,
    agentType, userPhone, requirementId, uiMediaOutputType, approvedImport, executionContext, commandSource, connectorContext);
  return refreshHarnessToolManifest(routeTools(
    decorateHostTools ? decorateHostTools(definitions) : definitions,
    { siteId, userId },
  ));
};

/**
 * Builds a lazy connector gateway before host decorators. Key presence never
 * grants access; only an explicitly admitted interactive host can resolve it.
 */
export async function getInstanceAssistantTools(
  siteId: string,
  userId: string | undefined,
  instanceId: string,
  customTools: any[] = [],
  agentType?: string,
  userPhone?: string,
  requirementId?: string,
  uiMediaOutputType?: UiMediaOutputType,
  approvedImport?: { url: string; sha256: string; userId: string },
  executionContext?: ToolExecutionContext,
  commandSource?: RequirementCommandSource,
  decorateHostTools?: (tools: RoutedTool[]) => RoutedTool[],
  connectorHost: 'assistant' | 'workflow' = 'workflow',
  connectorAgentId?: string,
  connectorIdHint?: string,
  sourceDigest?: string,
  leadBulkUserSession?: true,
  catalogUserSession?: true,
) {
  const connectorContext = assistantConnectorContext({ siteId, userId, instanceId, host: connectorHost, agentId: connectorAgentId, requestId: commandSource?.actionId, sourceDigest, connectorIdHint, ...(catalogUserSession === true && connectorHost === 'assistant' && { catalogUserSession: true as const }) });
  const instanceTools = [
    ...customTools.filter(tool => !['use_composio_tools', 'leads_bulk_operations'].includes(tool?.name)),
    composioActionTool(connectorContext,{accountPinned:connectorIdHint!==undefined}),
    // Bulk CRM writes need a verified interactive action, not an actor supplied by a background job.
    ...(leadBulkUserSession === true && connectorHost === 'assistant' && commandSource && commandSource.siteId === siteId
      && commandSource.userId === userId && commandSource.instanceId === instanceId
      ? [leadBulkOperationsTool(commandSource)] : []),
  ];

  return getAssistantTools(
    siteId,
    userId,
    instanceId,
    instanceTools,
    agentType,
    userPhone,
    requirementId,
    uiMediaOutputType,
    approvedImport,
    executionContext,
    commandSource,
    decorateHostTools,
    connectorContext,
  );
}
