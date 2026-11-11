import { getAvailableAgentProjects, canAccessAgentProject } from '@/lib/services/channels/agent-project-access';
import { saveAgentProjectSession } from '@/lib/services/channels/agent-project-session';

export interface InstanceProjectParams {
  action: 'list' | 'set';
  site_id?: string;
  /** Legacy argument retained for compatibility; never used as session identity. */
  email?: string;
}

export function instanceProjectTool(userId?: string | null, phone?: string) {
  return {
    name: 'instance_project',
    description: 'List available projects for the user or set the active project to work on.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'set'],
          description: 'The action to perform: "list" to get all available projects, "set" to select one to work on.'
        },
        site_id: {
          type: 'string',
          description: 'The ID of the project to set as active (required if action is "set").'
        },
        email: {
          type: 'string',
          description: 'Legacy field; ignored. Session identity is provided by the authenticated channel.'
        }
      },
      required: ['action']
    },
    execute: async (args: InstanceProjectParams) => {
      const { action, site_id } = args;
      try {
        if (!userId) {
          return {
            success: false,
            error: 'You are not logged in. Cannot manage projects.',
          };
        }

        if (action === 'list') {
          const availableSites = await getAvailableAgentProjects(userId);

          return {
            success: true,
            projects: availableSites,
          };
        } else if (action === 'set' && site_id) {
          if (!await canAccessAgentProject(userId, site_id)) {
            return {
              success: false,
              error: 'This project is unavailable or you do not have an active license for it.',
            };
          }

          if (!phone) {
            return {
              success: false,
              error: 'Missing authenticated channel identity to set active project session.',
            };
          }

          // Never accept a model-supplied email as the session owner.
          await saveAgentProjectSession(phone, userId, site_id, null);

          return {
            success: true,
            message: `Project ${site_id} is now set as your active project. For the next messages, I will assist you within the context of this project.`,
          };
        }

        return {
          success: false,
          error: 'Invalid action or missing parameters.',
        };
      } catch (err: any) {
        return {
          success: false,
          error: `Error: ${err.message}`,
        };
      }
    }
  };
}
