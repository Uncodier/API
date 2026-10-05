# WhatsApp image identity and ordering

## Investigation (2026-10-05)

The conversation summary mentioned a screenshot, but it was not available in
this session. Findings come from source review, offline regressions and
read-only database checks, not visual confirmation of the reported exchange.

The configured Makinari database had 23 WhatsApp assets added over the preceding
seven days. None had `metadata.message_sid`; all could be linked to a scoped
user-action log by their exact uploaded URL. Current source already writes these
IDs, suggesting a deployment/version gap or a different upload writer.

Two recent error logs showed separate provider failures: missing OpenRouter
configuration, and HTTP 402 requesting 65,536 output tokens when available
credits supported only 3,936. These do not establish which image the model saw.
No production rows, credentials or configuration were changed.

## Ordering and selection

- Assets are fetched in ascending `(created_at, id)` order, with explicit 200-row
  pages instead of one server-limited oldest-only result.
- `created_at` means date added to the instance, not photo capture date or
  guaranteed WhatsApp send/arrival order.
- The executor retains five trailing vision images. Reply targets are displayed
  last, and current attachments immediately before them. This display priority
  does not redefine upload chronology.
- Each image has an adjacent exact URL, asset ID, timestamp and optional message
  ID. `reply_target`, `current_attachment` and `latest_uploaded` distinguish
  quoted, current and chronological references.
- Legacy current attachments match the exact URL on a WhatsApp image attachment
  line. Arbitrary URLs and JSON-encoded quoted lines are not current attachments.
- An unquoted "this image" prefers the current attachment; a reply prefers its
  scoped target. "Latest uploaded" uses the upload timestamp/latest marker.
- Unresolved attachments and failed downloads include explicit unavailable-image
  instructions instead of silently leaving older images for the model to guess.

## Validation

Offline regressions cover current/quoted/latest references, timezone ordering,
seven-image filtering, mocked provider requests, checkpoint URL identity,
failed current-image download with an older visible image, pagination and failure
of a subsequent page. No customer image was sent to a live model.

Run from the repository root:

```sh
npm run test:ai -- --runTestsByPath src/lib/services/robot-instance/__tests__/assistant-image-content.test.ts src/lib/services/robot-instance/__tests__/InstanceAssetsService.test.ts src/lib/custom-automation/__tests__/ai-agent-executor-vision-references.test.ts
```

## Remaining limitations

1. The webhook persists user actions after transcription/download/upload. A slow
   earlier image can be registered after later text and supersede that instruction;
   later text can also build context before the image is ready. Durable inbound
   ordering and per-instance processing coordination are needed. This patch does
   not implement that coordination.
2. More than five requested images, or tool screenshots in subsequent iterations,
   can exceed/evict relevant vision context. Labels do not guarantee visibility.
3. Pagination retrieves the full inventory without a new token/asset budget or
   snapshot isolation against concurrent deletion.
4. Legacy reply identity is parsed from textual markers. A future structured
   boundary should separate authenticated webhook metadata from user-authored text.
5. This is a local patch, not a deployment/provider configuration change. Reproduce
   the actual exchange after deployment with the original screenshot and message
   identifiers before considering the incident closed.
