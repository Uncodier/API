import { fetchApiTool } from '@/app/api/agents/tools/utils/fetch-helper';

export interface TransactionsToolParams {
  action: 'create' | 'list' | 'get' | 'update' | 'delete';
  
  id?: string;
  site_id?: string;
  user_id?: string;
  type?: 'fixed' | 'variable';
  amount?: number;
  description?: string;
  date?: string;
  currency?: string;
  category?: string;
  
  limit?: number;
  offset?: number;
}

export function transactionsTool(current_site_id?: string, current_user_id?: string) {
  return {
    name: 'transactions',
    description:
      'Manage general expenses, salaries, and financial transactions. Use this tool when the user asks to register an expense (gasto) or salary. DO NOT use purchases for this. Use action="create" to record a new expense. Use list/get/update/delete for CRUD.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'get', 'update', 'delete'],
          description: 'Action to perform on transactions (expenses).',
        },
        id: { type: 'string', description: 'Transaction UUID (required for get, update, delete)' },
        site_id: { type: 'string', description: 'Site UUID' },
        type: { 
          type: 'string', 
          enum: ['fixed', 'variable'],
          description: 'Type of expense (fixed or variable)' 
        },
        amount: { type: 'number', description: 'Amount of the transaction' },
        description: { type: 'string', description: 'Description of the expense/transaction' },
        date: { type: 'string', description: 'Transaction date (YYYY-MM-DD)' },
        currency: { type: 'string', description: 'Currency code (e.g. USD, MXN)' },
        category: { type: 'string', description: 'Category of the expense' },
        limit: { type: 'number', description: 'Limit results for list' },
        offset: { type: 'number', description: 'Offset results for list' },
      },
      required: ['action'],
    },
    execute: async (args: TransactionsToolParams) => {
      const { action, ...params } = args;

      if (action === 'create') {
        if (params.amount === undefined || params.amount === null) throw new Error('Missing required field for create: amount');
        if (Number(params.amount) <= 0) throw new Error('Amount must be greater than 0');
        if (!params.type) throw new Error('Missing required field for create: type (fixed or variable)');
      }

      if ((action === 'update' || action === 'delete' || action === 'get') && !params.id) {
        throw new Error(`Missing required field id for action ${action}`);
      }

      const body = {
        action,
        ...params,
        site_id: params.site_id || current_site_id,
        user_id: params.user_id || current_user_id,
      };

      if (action === 'create' && !body.site_id) {
        throw new Error('Missing required field for create: site_id');
      }
      
      if (action === 'create' && !body.user_id) {
        throw new Error('Missing required field for create: user_id');
      }

      return await fetchApiTool('/api/agents/tools/transactions', body, `Transactions ${action} failed`);
    },
  };
}
