import { DataWorkflowService } from '@/lib/services/workflow/data-workflow-service';
import { BusinessWorkflowService } from '@/lib/services/workflow/business-workflow-service';

export interface WorkflowsToolParams {
  action: 
    | 'idealClientProfileMining'
    | 'buildCampaigns'
    | 'buildContent'
    | 'buildSegments'
    | 'buildSegmentsICP'
    | 'leadFollowUp'
    | 'leadResearch'
    | 'enrichLead'
    | 'leadGeneration'
    | 'analyzeSite'
    | 'assignLeads'
    | 'leadInvalidation'
    | 'dailyProspection'
    | 'leadQualification'
    | 'dailyStrategicAccounts'
    | 'sendEmailFromAgent'
    | 'sendWhatsappFromAgent'
    | 'scheduleCustomerSupport'
    | 'answerWhatsappMessage'
    | 'dailyStandUp'
    | 'customerSupportMessage'
    | 'agentMessage'
    | 'startRobot'
    | 'promptRobot'
    | 'stopRobot';
  payload: any;
}

export const workflowsTool = (siteId: string, userId?: string) => {
  return {
    name: 'workflows',
    description: 'Execute business and data workflows. Use this tool to trigger complex backend processes like lead research, campaign building, content generation, sending emails/whatsapp, etc.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'idealClientProfileMining',
            'buildCampaigns',
            'buildContent',
            'buildSegments',
            'buildSegmentsICP',
            'leadFollowUp',
            'leadResearch',
            'enrichLead',
            'leadGeneration',
            'analyzeSite',
            'assignLeads',
            'leadInvalidation',
            'dailyProspection',
            'leadQualification',
            'dailyStrategicAccounts',
            'sendEmailFromAgent',
            'sendWhatsappFromAgent',
            'scheduleCustomerSupport',
            'answerWhatsappMessage',
            'dailyStandUp',
            'customerSupportMessage',
            'agentMessage',
            'startRobot',
            'promptRobot',
            'stopRobot'
          ],
          description: 'The workflow action to execute.'
        },
        payload: {
          type: 'object',
          description: 'The parameters for the workflow. Must include site_id (automatically injected if not provided) and other specific fields depending on the action.'
        }
      },
      required: ['action', 'payload']
    },
    execute: async (args: WorkflowsToolParams) => {
      try {
        const { action, payload } = args;
        const dataService = DataWorkflowService.getInstance();
        const businessService = BusinessWorkflowService.getInstance();

        // Inject context if missing
        const workflowPayload = {
          site_id: siteId,
          userId: userId,
          user_id: userId,
          ...payload
        };

        switch (action) {
          // Data Workflows
          case 'idealClientProfileMining':
            return await dataService.idealClientProfileMining(workflowPayload);
          case 'buildCampaigns':
            return await dataService.buildCampaigns(workflowPayload);
          case 'buildContent':
            return await dataService.buildContent(workflowPayload);
          case 'buildSegments':
            return await dataService.buildSegments(workflowPayload);
          case 'buildSegmentsICP':
            return await dataService.buildSegmentsICP(workflowPayload);
          case 'leadFollowUp':
            return await dataService.leadFollowUp(workflowPayload);
          case 'leadResearch':
            return await dataService.leadResearch(workflowPayload);
          case 'enrichLead':
            return await dataService.enrichLead(workflowPayload);
          case 'leadGeneration':
            return await dataService.leadGeneration(workflowPayload);
          case 'analyzeSite':
            return await dataService.analyzeSite(workflowPayload);
          case 'assignLeads':
            return await dataService.assignLeads(workflowPayload);
          case 'leadInvalidation':
            return await dataService.leadInvalidation(workflowPayload);
          case 'dailyProspection':
            return await dataService.dailyProspectionWorkflow(workflowPayload);
          case 'leadQualification':
            return await dataService.leadQualificationWorkflow(workflowPayload);
          case 'dailyStrategicAccounts':
            return await dataService.dailyStrategicAccountsWorkflow(workflowPayload);
          
          // Business Workflows
          case 'sendEmailFromAgent':
            return await businessService.sendEmailFromAgent(workflowPayload);
          case 'sendWhatsappFromAgent':
            return await businessService.sendWhatsappFromAgent(workflowPayload);
          case 'scheduleCustomerSupport':
            return await businessService.scheduleCustomerSupport(workflowPayload);
          case 'answerWhatsappMessage':
            return await businessService.answerWhatsappMessage(workflowPayload);
          case 'dailyStandUp':
            return await businessService.dailyStandUp(workflowPayload);
          case 'customerSupportMessage':
            return await businessService.customerSupportMessage(workflowPayload);
          case 'agentMessage':
            return await businessService.agentMessage(workflowPayload);
          case 'startRobot':
            return await businessService.startRobot(workflowPayload);
          case 'promptRobot':
            return await businessService.promptRobot(workflowPayload);
          case 'stopRobot':
            return await businessService.stopRobot(workflowPayload);
            
          default:
            return { success: false, error: `Unknown workflow action: ${action}` };
        }
      } catch (error: any) {
        console.error(`Error executing workflow ${args.action}:`, error);
        return { success: false, error: error.message };
      }
    }
  };
};
