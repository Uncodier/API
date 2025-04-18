/**
 * ToolEvaluator - Type definitions
 */
import { DbCommand } from '../../models/types';

// Interfaces para el nuevo formato de respuesta
export interface ToolExclusion {
  reasoning: string;
  type: "exclusion";
  name: string;
}

// Formato para almacenar en command.functions
export interface FunctionCall {
  id: string;
  type: "function";
  status: "initialized";
  function: {
    name: string;
    arguments: string;
  };
}

// Tipo unión para las decisiones de herramientas (exclusiones o llamadas a funciones directas)
export type ToolDecision = ToolExclusion | FunctionCall; 