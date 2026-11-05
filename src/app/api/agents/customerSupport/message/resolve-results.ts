import { extractSupportResults } from './results';

/** Re-read only the same persisted command, never generate another reply here. */
export async function resolveSupportResults(
  command: any,
  readSameCommand: () => Promise<any>,
) {
  let results = extractSupportResults(command);
  if (results.assistantMessage) return results;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 200));
    const fresh = await readSameCommand();
    if (fresh?.status !== 'completed') continue;
    results = extractSupportResults(fresh);
    if (results.assistantMessage) return results;
  }
  return null;
}