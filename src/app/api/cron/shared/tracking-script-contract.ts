export const HARNESS_TRACKING_SCRIPT_URL =
  'https://files.uncodie.com/tracking.min.js';

export const HARNESS_TRACKING_ATTRIBUTE =
  'data-uncodie-harness="tracking"';

export function buildHarnessTrackingScriptTag(siteId: string): string {
  return `<script src="${HARNESS_TRACKING_SCRIPT_URL}" data-site-id="${siteId}" ${HARNESS_TRACKING_ATTRIBUTE}></script>`;
}

export function buildLegacyTrackingScriptTag(siteId: string): string {
  return `<script src="${HARNESS_TRACKING_SCRIPT_URL}" data-site-id="${siteId}"></script>`;
}
