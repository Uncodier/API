---
name: automations-n8n-zapier
description: Designs robust webhooks and integrates with automation platforms like n8n, Make, and Zapier using idempotency and retry logic.
types: ['automation', 'integration']
---

# SKILL: automations-n8n-zapier

## Objective
Design and implement robust system integrations, workflow automations, and API endpoints. Follow best practices when creating webhooks or connecting to external platforms like n8n, Zapier, or Make.

## Instructions
1. **Webhook Design:**
   - **Idempotency:** Design webhooks to be idempotent. Receiving the same event multiple times must yield the same result as receiving it once.
   - **Signature Validation:** Always verify the webhook signature to ensure the request comes from a trusted source (e.g., Stripe, GitHub, Shopify).
   - **Asynchronous Processing:** Respond quickly to the webhook (HTTP 200) and process the payload asynchronously (e.g., using message queues like Redis, SQS, or background workers) to avoid timeouts.
2. **Automation Platform Integration:**
   - **Data Format:** Send and receive data in a structured, predictable JSON format. Avoid overly complex nested structures if the target platform struggles to map them.
   - **Error Handling:** Implement robust error handling. If an API call fails, log the error in detail (including payload and HTTP status code).
   - **Retry Logic:** Implement retries with exponential backoff to handle temporary network failures or third-party API rate limits.
3. **Security & Performance:**
   - **Authentication:** Protect automation endpoints using access tokens, API keys, or basic authentication. Never expose unprotected endpoints.
   - **Rate Limiting:** Implement rate limits on your own public endpoints to prevent abuse or overload.
   - **Logging:** Properly log important events (e.g., "Webhook received", "Processing completed", "Integration X error") to facilitate debugging.

## Tools
| Tool | When to use |
| --- | --- |
| `sandbox_write_file` | Create or update API routes, webhook handlers, and background jobs. |

## Artifacts
- **Produces**: Secure, idempotent webhook endpoints and integration scripts.
- **Consumes**: `requirement.instructions` (automation workflows and payload schemas).
