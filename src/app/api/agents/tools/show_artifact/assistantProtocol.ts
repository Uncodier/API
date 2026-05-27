import { createInstanceArtifactCore, SCREEN_MAP, ScreenKey } from './route';

export function showArtifactTool(site_id: string, instance_id: string, user_id?: string) {
  return {
    name: 'show_artifact',
    description: `Focus the user UI on a specific curated screen and persist the event so the front-end can reactively display the artifact. 
Use this when you want to show a report, open a specific settings panel, or navigate the user to a relevant section of the app as a result of their request.

Available screens and their primary front-end actions (TopBar/Toolbar):
### Marketing
- campaigns: ✨ Build with AI, ➕ New Campaign, 🔍 Search, Filters (Status, Priority), Sort (Due date, Oldest, Newest, Budget, ROI).
- segments: ✨ Build with AI, ➕ New Segment, 🔍 Search, Filters (Status).
- content: ✨ Build with AI, ➕ New Content, 🔍 Search, Filters (Status, Type, Segments), Sort, View (Table/Kanban).
- assets: ☁️ Upload Asset, 🔍 Search.

### Sales
- sales_home: Quick actions: ➕ Register Sale, 👥 View Leads, 💼 Open Deals.
- control_center: ➕ New Task.
- sales: 📥 Export, ➕ Register Sale, 🔍 Search, Filters, Sort, View (Table/Kanban).
- leads: 📤 Import, 📥 Export, 🔍 Search, Filters (Status, Segments, Origin), Sort, Bulk actions (Cancel, Assign to me, Change Status, Delete).
- deals: ➕ Create Deal, 🔍 Search, Sort, View (Table/Kanban).
- chat: 🔍 Search conversations/contacts.
- people: 🔍 Search, ➕ Enrich Leads, ➕ Enrich & prospect selected.

### Automation
- context: 📑 Context tabs (General, Knowledge, Docs).
- agents_configuration: 🔍 Search agents, 📑 Filter by status/type.
- requirements: ➕ New Requirement, 🔍 Search, Filters (Priority, Completion Status, Segments), Sort, View.
- channels_settings: 📑 Navigate Channel settings.
- activities_settings: 📑 Navigate Activity settings.
- skills: View agent skills list.

### Applications
- applications_database: 🔍 Search DB/tables, View (Table/Kanban).
- applications_repositories: 🔍 Search repos, View (Table/Kanban).

### Reports (Dashboard)
- performance_report, overview_report, analytics_report, traffic_report, sales_report: 📥 Export, 📅 Date range, 🏷️ Global Segment selector, 📑 Tabs navigation.
- costs_report: 📅 Date range, 🏷️ Segment selector.

*Note: Content Creator / Imprenta (/robots) has special actions like ▶️ Start/Stop Robot.*`,
    parameters: {
      type: 'object',
      properties: {
        screen: { 
          type: 'string', 
          enum: Object.keys(SCREEN_MAP), 
          description: 'The curated key of the screen to show. Must be one of the enumerated keys.' 
        },
        title: { 
          type: 'string', 
          description: 'Optional human label shown alongside the artifact to explain what is being shown.' 
        },
        description: { 
          type: 'string', 
          description: 'Optional rationale: why this screen is being shown now in the context of the conversation.' 
        },
        extra_params: { 
          type: 'object', 
          description: 'Optional extra query parameters to merge into the URL before the artifact=true flag.' 
        },
        should_reload: { 
          type: 'boolean', 
          description: 'Set to true if the front-end should force-reload the data on that screen even if the user is already looking at it. Defaults to false.' 
        }
      },
      required: ['screen']
    },
    execute: async (args: {
      screen: ScreenKey;
      title?: string;
      description?: string;
      extra_params?: Record<string, any>;
      should_reload?: boolean;
    }) => {
      try {
        const data = await createInstanceArtifactCore({
          site_id,
          instance_id,
          user_id,
          ...args
        });
        return { success: true, data };
      } catch (error: any) {
        throw new Error(error.message || 'Failed to execute show_artifact tool');
      }
    }
  };
}
