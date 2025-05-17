export const emailAgentSchema = {
  type: 'object',
  properties: {
    site_id: {
      type: 'string',
      description: 'ID of the site to analyze emails for',
      example: 'f87bdc7f-0efe-4aa5-b499-49d85be4b154'
    },
    agentId: {
      type: 'string',
      description: 'ID of the agent to handle the analysis. If not provided, will use the site\'s Customer Support agent',
      example: '478d3106-7391-4d9a-a5c1-8466202b45a9'
    },
    limit: {
      type: 'number',
      description: 'Maximum number of emails to fetch',
      default: 10,
      example: 1
    },
    user_id: {
      type: 'string',
      description: 'Optional user ID to associate with the command',
      example: 'user_xyz789'
    },
    lead_id: {
      type: 'string',
      description: 'Optional lead ID to associate with the analysis'
    },
    team_member_id: {
      type: 'string',
      description: 'Optional team member ID to associate with the analysis'
    },
    analysis_type: {
      type: 'string',
      description: 'Type of analysis to perform',
      enum: ['comprehensive', 'commercial_opportunity', 'sentiment', 'quick']
    }
  },
  required: ['site_id']
}; 