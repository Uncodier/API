import { processAssistantTurn as processTurn } from './assistant-turn-core';

/** No automatic replay of a step that can publish, send or mutate state. */
export async function processAssistantTurn(...args: Parameters<typeof processTurn>) {
  'use step';
  return processTurn(...args);
}
processAssistantTurn.maxRetries = 0;