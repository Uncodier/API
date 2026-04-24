---
name: ads-meta-google
description: Implements technical tracking for Meta Pixel, Conversions API (CAPI), and Google Tag, and analyzes campaigns using MCPs.
types: ['optimization', 'marketing_campaign', 'integration']
---

# SKILL: ads-meta-google

## Objective
Implement MarTech (Marketing Technology) and digital advertising analytics. Configure tracking pixels, conversion APIs, campaign attribution scripts, and analyze ad performance using best practices.

## Instructions
1. **Server-Side Tracking (Conversions API / CAPI):** Prioritize server-side tracking over client-side tracking to evade ad blockers and browser restrictions (ITP/ETP). For **Meta CAPI**, ensure required parameters are sent (`event_name`, `event_time`, `action_source`, `user_data`). Hash (SHA-256) user data (`em`, `ph`, `fn`, `ln`) before sending. Implement a unique `event_id` and send it both client-side and server-side for proper deduplication.
2. **Client-Side Tracking (Pixels & Tags):**
   - **Meta Pixel (`fbq`):** Load the base script early, but respect user consent (Consent Mode). Fire standard events (`ViewContent`, `AddToCart`, `Purchase`) with correct parameters (`value`, `currency`, `content_ids`).
   - **Google Tag (`gtag.js`):** Configure GA4 and Google Ads correctly. Use `gtag('event', ...)` for conversions and send the `transaction_id` on purchases to prevent duplicate conversions.
3. **Attribution & UTM Parameters:** Capture and persist UTM parameters (`utm_source`, `utm_medium`, `utm_campaign`) and click IDs (`fbclid`, `gclid`, `wbraid`) from the URL into first-party cookies or `localStorage`. Send these parameters with conversion events (both client and server-side) to ensure correct campaign attribution.
4. **Privacy & Consent (GDPR/CCPA):** Implement Google Consent Mode v2 and respect user cookie preferences before firing any pixel or sending data to conversion APIs. Do not send Personally Identifiable Information (PII) in plain text via URLs or client-side events.
5. **Campaign Analysis (MCPs):** When asked to analyze campaigns or search for creatives, use MCP servers like **Facebook Ads Library MCP**, **Google Ads MCP by TrueClicks**, or **Google Ads Library MCP**. Use GAQL (Google Ads Query Language) to extract performance metrics, analyze keywords, and evaluate ROI/ROAS.

## Tools
| Tool | When to use |
| --- | --- |
| `sandbox_write_file` | Implement tracking scripts, CAPI endpoints, or attribution logic. |

## Artifacts
- **Produces**: Tracking implementations (Client-Side and Server-Side) and campaign analysis reports.
- **Consumes**: `requirement.instructions` (tracking requirements and campaign goals).
