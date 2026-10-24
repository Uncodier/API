import { prepareAssistantContext as prepareContext } from './assistant-context';

/** Durable transport wrapper; cron and interactive execution share the same core. */
export async function prepareAssistantContext(...args: Parameters<typeof prepareContext>) {
  'use step';
  return prepareContext(...args);
}