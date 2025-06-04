#!/usr/bin/env node

/**
 * Test script para verificar que la autenticación de herramientas funciona correctamente
 */

import { executeTools } from '../src/lib/agentbase/agents/toolEvaluator/executor/executeTools.js';
import { ToolsMap } from '../src/lib/agentbase/agents/toolEvaluator/executor/toolsMap.js';

// Mock de herramientas para testing
const mockToolsMap = {};

// Test de llamada de función que requiere autenticación
const testFunctionCall = {
  id: 'test_call_1',
  name: 'CREATE_TASK',
  arguments: JSON.stringify({
    title: 'Test Task',
    type: 'meeting',
    lead_id: '12345-67890-abcdef',
    scheduled_date: '2024-01-15T14:00:00Z'
  })
};

async function runTest() {
  console.log('🧪 Testing tool authentication...');
  console.log('SERVICE_API_KEY:', process.env.SERVICE_API_KEY ? 'SET' : 'NOT SET');
  console.log('NODE_ENV:', process.env.NODE_ENV);
  console.log('');

  try {
    const results = await executeTools([testFunctionCall], mockToolsMap);
    
    console.log('✅ Test completed successfully');
    console.log('Results:', JSON.stringify(results, null, 2));
    
    // Verificar que no haya errores 401
    const hasAuthError = results.some(r => r.error && r.error.includes('401'));
    if (hasAuthError) {
      console.log('❌ Authentication error detected');
      process.exit(1);
    } else {
      console.log('✅ No authentication errors found');
    }
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    process.exit(1);
  }
}

// Solo ejecutar si es llamado directamente
if (import.meta.url === `file://${process.argv[1]}`) {
  runTest();
} 