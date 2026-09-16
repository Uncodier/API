import { extractVisualFeedbackScreenshotUrl } from './step-visual-feedback';
import { fetchVisualScreenshotDataUrl } from './visual-screenshot-data';

export interface StepRetryFeedback {
  promptFragment: string;
  imageFeedbackId?: string;
  imageMessage?: {
    role: 'user';
    content: Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string; detail: 'low' } }
    >;
  };
}

function feedbackId(url: string, context: string): string {
  let stableValue = url;
  try {
    stableValue = new URL(url).pathname;
  } catch {
    // Keep the original value for malformed locators; fetching will reject it.
  }
  stableValue += `\n${context.replace(
    /^visual_screenshot_url:\s*\S+/gim,
    '',
  )}`;
  let hash = 2166136261;
  for (let index = 0; index < stableValue.length; index++) {
    hash ^= stableValue.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export async function buildStepRetryFeedback(
  errorMessage: string | null | undefined,
  previouslyInjectedId?: string,
  requirementId?: string,
): Promise<StepRetryFeedback> {
  if (!errorMessage) return { promptFragment: '' };
  const boundedError = errorMessage.slice(0, 8_000);

  const promptFragment = `\n\n🚨 PREVIOUS ATTEMPT FAILED 🚨
The previous execution of this step failed with the following error:

${boundedError}

Fix only the violating lines. For investigations, append to the existing docs/investigations/*.md — never delete the named deliverable or rewrite it from scratch. If it asks for https:// citations, add real URLs from webSearch. You MUST fix this during this attempt.`;

  const screenshotUrl = extractVisualFeedbackScreenshotUrl(boundedError);
  if (!screenshotUrl) return { promptFragment };
  const imageFeedbackId = feedbackId(screenshotUrl, boundedError);
  if (previouslyInjectedId === imageFeedbackId) {
    return { promptFragment, imageFeedbackId };
  }
  if (!requirementId) return { promptFragment };
  const image = await fetchVisualScreenshotDataUrl(screenshotUrl, {
    requirementId,
  });
  if (!image) return { promptFragment };

  return {
    promptFragment,
    imageFeedbackId,
    imageMessage: {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'This is the visual evidence for the blocking critic feedback in the system prompt. Inspect it before choosing the next fix. Change only the affected route or component.',
        },
        {
          type: 'image_url',
          image_url: { url: image, detail: 'low' },
        },
      ],
    },
  };
}
