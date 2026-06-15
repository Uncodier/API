---
name: makinari-outbound-campaign
description: Guides the agent to review segments, create campaigns, generate ICP lists for enrichment, draft sequence copy, and verify outbound channels.
types: ['marketing_campaign', 'content', 'task']
---

# Makinari Outbound Campaign

## Objective
To successfully orchestrate an outbound marketing campaign by ensuring that audience segments are clean, an Ideal Customer Profile (ICP) list is prepared for enrichment, sequence copy is drafted, and the required outbound channels (WhatsApp or Email) are verified and ready for execution.

## Instructions
1. **Verify Outbound Channel Readiness:** Before creating any campaign assets, verify that the agent has an active and configured outbound channel (either WhatsApp or Email). Do not proceed if a channel is not ready; explicitly report this blocker.
2. **Review and Debug Segments:** Analyze the existing audience segments. Identify and clean up any inconsistencies, duplicates, or invalid records to ensure the segment is depurated and highly targeted.
3. **Create the Campaign:** Initialize the campaign structure in the system or document. Define the campaign's goals, timelines, and the specific segments it will target.
4. **Create ICP List for Enrichment:** Generate a detailed Ideal Customer Profile (ICP) list. Document the specific criteria (e.g., industry, role, company size, geolocation) required so the list can be sent for data enrichment.
5. **Draft Sequence Copy:** Write the outreach sequence copy for the user. Ensure the messaging is tailored to the ICP and optimized for the specific outbound channel being used (e.g., shorter texts for WhatsApp, structured subjects for Email). The copy must include the initial outreach message and necessary follow-ups.
6. **Report Status:** Document all the created assets (campaign details, ICP list, sequence copy) and the channel verification status. Update the requirement status so the user can review the copy and the ICP list.

## Tools

| Tool | When to use |
| --- | --- |
| `sandbox_read_file` | Read existing segment data, ICP definitions, or previous campaign setups. |
| `sandbox_write_file` | Save campaign plans, ICP lists, and sequence copy files to the repository. |
| `sandbox_list_files` | Enumerate directory contents to find existing campaign materials or segments. |
| `requirements` | Read the initial requirement instructions and append structured campaign details. |
| `requirement_status` | Publish the progress and final delivery, including links to the drafted copy and ICP lists. |

## Artifacts

- **Produces**: `campaign_plan.md` (campaign goals and segments), `icp_enrichment_list.json` (criteria for data enrichment), `sequence_copy.md` (drafted messages for WhatsApp/Email).
- **Consumes**: `requirement.instructions` (for context on the campaign goals and target audience).
