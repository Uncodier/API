import { extractSupportResults } from './results';

/** Re-read only the same persisted command, never generate another reply here. */
export async function resolveSupportResults(
  command: any,
  readSameCommand: () => Promise<any>,
) {
  let results = extractSupportResults(command);
  if (results.assistantMessage !== undefined) return results;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 200));
    let fresh;
    try {
      fresh = await readSameCommand();
    } catch {
      // Read failures stay inside the bounded recovery path.
      continue;
    }
    if (fresh?.status !== 'completed') continue;
    results = extractSupportResults(fresh);
    if (results.assistantMessage !== undefined) return results;
  }
  return null;
}