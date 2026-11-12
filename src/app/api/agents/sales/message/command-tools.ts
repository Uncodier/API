import { TASK_DEDUPLICATION_KEY_DESCRIPTION } from '@/app/api/agents/customerSupport/support-policies';
/** Existing command tool contract, unchanged. */
export function commandTools() { return [
        {
          type: "function",
          async: true,
          function: {
            name: 'SCHEDULE_MEETING',
            description: 'Schedule a meeting or product demo with the lead',
            parameters: {
              type: 'object',
              properties: {
                conversation: {
                  type: 'string',
                  description: 'The conversation ID for the current interaction'
                },
                lead_id: {
                  type: 'string',
                  description: 'The ID of the lead to schedule with'
                },
                purpose: {
                  type: 'string',
                  description: 'Brief description of the meeting purpose (product demo, consultation, etc.)'
                },
                preferred_date: {
                  type: 'string',
                  description: 'Preferred date for the meeting (ISO format or natural language)'
                },
                preferred_time: {
                  type: 'string',
                  description: 'Preferred time for the meeting'
                }
              },
              required: ['conversation', 'lead_id', 'purpose'],
              additionalProperties: false
            },
            strict: true
          }
        },
        {
          type: "function",
          async: true,
          function: {
            name: 'CREATE_SALE',
            description: 'Create a new sales order or opportunity based on customer needs',
            parameters: {
              type: 'object',
              properties: {
                conversation: {
                  type: 'string',
                  description: 'The conversation ID for the current interaction'
                },
                lead_id: {
                  type: 'string',
                  description: 'The ID of the lead or customer for this sale'
                },
                products: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: {
                        type: 'string',
                        description: 'Product or service name'
                      },
                      quantity: {
                        type: 'number',
                        description: 'Quantity of this product'
                      },
                      price: {
                        type: 'number',
                        description: 'Price per unit'
                      }
                    },
                    required: ['name']
                  },
                  description: 'List of products or services the customer is interested in'
                },
                notes: {
                  type: 'string',
                  description: 'Additional notes about the sale'
                }
              },
              required: ['conversation', 'lead_id'],
              additionalProperties: false
            },
            strict: true
          }
        },
        {
          type: "function",
          async: true,
          function: {
            name: 'IDENTIFY_LEAD',
            description: 'collect visitor information when lead or visitor data is missing from context',
            parameters: {
              type: 'object',
              properties: {
                conversation: {
                  type: 'string',
                  description: 'The conversation ID for the current interaction'
                },
                name: {
                  type: 'string',
                  description: 'Name of the visitor'
                },
                email: {
                  type: 'string',
                  description: 'Email address of the visitor'
                },
                phone: {
                  type: 'string',
                  description: 'Phone number of the visitor'
                },
                company: {
                  type: 'string',
                  description: 'Company name of the visitor'
                }
              },
              required: ['name', 'email', 'phone'],
              additionalProperties: false
            },
            strict: true
          }
        },
        {
          type: "function",
          async: true,
          function: {
            name: 'CREATE_TASK',
            description: 'Create a task only after a successful GET_TASKS lookup of every page for this lead without title/search or type filters, reviewing pending and in_progress. For the same need, even with a paraphrased title, use UPDATE_TASK preserving existing information. Never create after a failed lookup.',
            parameters: {
              type: 'object',
              properties: {
                title: {
                  type: 'string',
                  description: 'Title of the task to be created'
                },
                deduplication_key: {
                  type: 'string',
                  description: TASK_DEDUPLICATION_KEY_DESCRIPTION
                },
                type: {
                  type: 'string',
                  description: 'Type of task to create (e.g., call, email, demo, meeting, quote, payment, follow_up, support, custom types allowed)'
                },
                lead_id: {
                  type: 'string',
                  description: 'The ID of the lead this task is related to (required)'
                },
                description: {
                  type: 'string',
                  description: 'Detailed description of what needs to be done'
                },
                stage: {
                  type: 'string',
                  enum: ['awareness', 'consideration', 'decision', 'purchase', 'retention', 'referral'],
                  description: 'Stage from customer journey'
                },
                scheduled_date: {
                  type: 'string',
                  format: 'date-time',
                  description: 'When the task should be scheduled (or the same day if not specified) (ISO 8601 format with timezone) example: 2025-03-24 20:21:51.906+00',
                },
                notes: {
                  type: 'string',
                  description: 'Additional notes about the task'
                },
                amount: {
                  type: 'number',
                  description: 'Monetary amount associated with the task (e.g., quote value, payment amount)'
                },
                address: {
                  type: 'object',
                  description: 'Address information as JSON object',
                  properties: {
                    street: {
                      type: 'string',
                      description: 'Street address'
                    },
                    city: {
                      type: 'string',
                      description: 'City name'
                    },
                    state: {
                      type: 'string',
                      description: 'State or province'
                    },
                    postal_code: {
                      type: 'string',
                      description: 'Postal or ZIP code'
                    },
                    country: {
                      type: 'string',
                      description: 'Country name'
                    }
                  },
                  required: ['street', 'city', 'country'],
                  additionalProperties: true
                }
              },
              required: ['title', 'type', 'lead_id', 'deduplication_key', "scheduled_date", "stage", "description"],
              additionalProperties: false
            },
            strict: true
          }
        },
        {
          type: "function",
          async: true,
          function: {
            name: 'UPDATE_TASK',
            description: 'update an existing task with new information, status changes, or progress updates',
            parameters: {
              type: 'object',
              properties: {
                task_id: {
                  type: 'string',
                  description: 'The ID of the task to update (required)'
                },
                title: {
                  type: 'string',
                  description: 'New title of the task'
                },
                type: {
                  type: 'string',
                  description: 'New type of task (e.g., call, email, demo, meeting, quote, payment, follow_up, support, custom types allowed)'
                },
                description: {
                  type: 'string',
                  description: 'New detailed description of what needs to be done'
                },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'completed', 'failed'],
                  description: 'New status of the task'
                },
                stage: {
                  type: 'string',
                  enum: ['awareness', 'consideration', 'decision', 'purchase', 'retention', 'referral'],
                  description: 'New stage from customer journey'
                },
                priority: {
                  type: 'integer',
                  minimum: 0,
                  description: 'New priority level (higher numbers = higher priority)'
                },
                scheduled_date: {
                  type: 'string',
                  format: 'date-time',
                  description: 'When the task should be scheduled (or the same day if not specified) (ISO 8601 format with timezone) example: 2025-03-24 20:21:51.906+00',
                },
                amount: {
                  type: 'number',
                  description: 'New monetary amount associated with the task (e.g., quote value, payment amount)'
                },
                assignee: {
                  type: 'string',
                  description: 'ID of the user to assign the task to'
                },
                notes: {
                  type: 'string',
                  description: 'New or additional notes about the task'
                },
                address: {
                  type: 'object',
                  description: 'New address information as JSON object',
                  properties: {
                    street: {
                      type: 'string',
                      description: 'Street address'
                    },
                    city: {
                      type: 'string',
                      description: 'City name'
                    },
                    state: {
                      type: 'string',
                      description: 'State or province'
                    },
                    postal_code: {
                      type: 'string',
                      description: 'Postal or ZIP code'
                    },
                    country: {
                      type: 'string',
                      description: 'Country name'
                    },
                    venue_name: {
                      type: 'string',
                      description: 'Name of the venue or location'
                    },
                    room: {
                      type: 'string',
                      description: 'Room or suite number'
                    },
                    floor: {
                      type: 'string',
                      description: 'Floor number'
                    },
                    parking_instructions: {
                      type: 'string',
                      description: 'Parking instructions'
                    },
                    access_code: {
                      type: 'string',
                      description: 'Access code for entry'
                    }
                  },
                  additionalProperties: true
                }
              },
              required: ['task_id'],
              additionalProperties: false
            },
            strict: true
          }
        },
        {
          type: "function",
          async: true,
          function: {
            name: 'GET_TASKS',
            description: 'Retrieve tasks. Before CREATE_TASK, list this lead without title/search or type filters; review pending and in_progress across all pages with limit/offset until pagination.has_more=false. Failed or incomplete lookups do not permit creation.',
            parameters: {
              type: 'object',
              properties: {
                lead_id: {
                  type: 'string',
                  description: 'The ID of the lead to get tasks for (primary filter)'
                },
                type: {
                  type: 'string',
                  description: 'Type of task to filter by (e.g., call, email, demo, meeting, quote, payment)'
                },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'completed', 'failed'],
                  description: 'Status of tasks to retrieve'
                },
                stage: {
                  type: 'string',
                  enum: ['awareness', 'consideration', 'decision', 'purchase', 'retention', 'referral'],
                  description: 'Stage of tasks to filter by (from customer_journey)'
                },
                priority: {
                  type: 'integer',
                  description: 'Priority level to filter by (higher numbers = higher priority)'
                },
                search: {
                  type: 'string',
                  description: 'Search text to find in task titles or descriptions'
                },
                sort_by: {
                  type: 'string',
                  enum: ['created_at', 'updated_at', 'scheduled_date', 'priority', 'title'],
                  description: 'Field to sort results by'
                },
                sort_order: {
                  type: 'string',
                  enum: ['asc', 'desc'],
                  description: 'Sort order for results'
                },
                limit: {
                  type: 'integer',
                  minimum: 1,
                  maximum: 100,
                  description: 'Maximum number of tasks to return'
                },
                include_completed: {
                  type: 'boolean',
                  description: 'Whether to include completed tasks in results'
                },
                include_archived: {
                  type: 'boolean',
                  description: 'Whether to include archived tasks (false for open-task deduplication)'
                },
                offset: {
                  type: 'integer',
                  minimum: 0,
                  description: 'Pagination offset; advance by returned count while pagination.has_more is true'
                }
              },
              required: ['lead_id'],
              additionalProperties: false
            },
            strict: true
          }
        }
      ]; }
