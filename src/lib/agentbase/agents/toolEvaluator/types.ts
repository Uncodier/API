/**
 * ToolEvaluator - Type definitions
 */
// import { DbCommand } from '../../models/types';

/**
 * @typedef {Object} ToolExclusion
 * @property {string} reasoning - Razonamiento para excluir la herramienta
 * @property {"exclusion"} type - Tipo de decisión
 * @property {string} name - Nombre de la herramienta excluida
 */
export interface ToolExclusion {
  reasoning: string;
  type: "exclusion";
  name: string;
}

/**
 * @typedef {Object} FunctionCall
 * @property {string} id - ID único de la llamada a función
 * @property {"function"} type - Tipo de decisión
 * @property {string} status - Estado de la función
 * @property {string} name - Nombre de la herramienta
 * @property {string|object} arguments - Argumentos serializados como JSON
 * @property {boolean} [critical] - Indica si la función es crítica
 * @property {string} [description] - Descripción de la función
 * @property {string[]} [required_arguments] - Lista de argumentos requeridos pero faltantes (solo cuando status es "possible_match")
 */
export interface FunctionCall {
  id: string;
  type: "function";
  status: string;
  name: string;
  arguments: string | object;
  critical?: boolean;
  description?: string;
  required_arguments?: string[];
  result?: any;
  error?: any;
}

/**
 * @typedef {ToolExclusion|FunctionCall} ToolDecision
 */
export type ToolDecision = ToolExclusion | FunctionCall;

// Export los tipos para que sean accesibles
export const ToolDecisionTypes = {
  EXCLUSION: "exclusion",
  FUNCTION: "function"
};

export const FunctionCallStatus = {
  INITIALIZED: "initialized",
  REQUIRED: "required",
  COMPLETED: "completed",
  ERROR: "error",
  FAILED: "failed",
  POSSIBLE_MATCH: "possible_match"
};

/**
 * Represents a result of tool execution
 */
export interface ToolExecutionResult {
  /** Unique identifier for the execution result */
  id: string;
  /** Status of the execution */
  status: 'success' | 'error';
  /** Error message if status is error */
  error: string | null;
  /** Output of the tool execution */
  output: any;
  /** Name of the function that was executed (optional) */
  function_name?: string;
  /** Arguments that were used in the execution (optional) */
  arguments?: string | object;
}

/**
 * Represents a function definition and its handler
 */
export interface ToolDefinition {
  /** Name of the tool */
  name: string;
  /** Description of what the tool does */
  description: string;
  /** Function implementation */
  function?: (...args: any[]) => any;
  /** Alternative handler name */
  handler?: (...args: any[]) => any;
  /** Schema for the tool */
  schema?: any;
} 