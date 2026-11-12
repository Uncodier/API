/** Existing command tool contract, unchanged. */
export function commandTools() { return [
        {
          name: "analyze_campaign",
          description: "analyze marketing campaign performance with metrics and insights",
          status: "not_initialized",
          type: "synchronous",
          parameters: {
            type: "object",
            properties: {
              campaign_id: {
                type: "string",
                description: "The ID of the campaign to analyze"
              },
              date_range: {
                type: "string",
                description: "The date range for analysis (e.g., 'last_30_days', 'last_quarter')"
              },
              metrics: {
                type: "array",
                items: {
                  type: "string"
                },
                description: "The specific metrics to analyze (e.g., 'conversion_rate', 'engagement')"
              }
            },
            required: ["campaign_id"]
          }
        },
        {
          name: "generate_content_plan",
          description: "create a content marketing plan or strategy",
          status: "not_initialized",
          type: "synchronous",
          parameters: {
            type: "object",
            properties: {
              business_vertical: {
                type: "string",
                description: "The industry or business vertical"
              },
              target_audience: {
                type: "string",
                description: "Description of the target audience"
              },
              goals: {
                type: "array",
                items: {
                  type: "string"
                },
                description: "The goals for this content plan"
              },
              timeframe: {
                type: "string",
                description: "The timeframe for the content plan (e.g., 'quarterly', 'annual')"
              }
            },
            required: ["business_vertical", "target_audience", "goals"]
          }
        },
        {
          name: "schedule_meeting",
          description: "schedule a strategy session with a marketing specialist",
          status: "not_initialized",
          type: "asynchronous",
          parameters: {
            type: "object",
            properties: {
              contact_id: {
                type: "string",
                description: "The ID of the contact requesting the meeting"
              },
              date_time: {
                type: "string",
                description: "The proposed date and time for the meeting (ISO format)"
              },
              meeting_topic: {
                type: "string",
                description: "The topic for the strategy session",
                enum: ["content_strategy", "campaign_analysis", "market_research", "brand_positioning"]
              }
            },
            required: ["contact_id", "date_time", "meeting_topic"]
          }
        }
      ]; }
