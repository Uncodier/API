---
name: makinari-outbound-campaign
description: Guides the agent to review segments, create campaigns, generate ICP lists for enrichment, draft sequence copy, and verify outbound channels.
types: ['marketing_campaign', 'content', 'task']
---

# Makinari Outbound Campaign

## Objective
To successfully orchestrate an outbound marketing campaign by ensuring that audience segments are clean, an Ideal Customer Profile (ICP) list is prepared for enrichment, sequence copy is drafted, and the required outbound channels (WhatsApp or Email) are verified and ready for execution.

## Instructions
1. **Verify Outbound Channel Readiness:** Use `configure_whatsapp` (action `get_config`) or `configure_email` to verify that the agent has an active and configured outbound channel. Do not proceed if a channel is not ready; explicitly report this blocker in `requirement_status`.
2. **Review and Debug Segments:** Use the `segments` tool (`action="list"`) to analyze the existing audience segments. Use `action="update"` to clean up or adjust segments, ensuring they are highly targeted.
3. **Create the Campaign:** Use the `campaigns` tool (`action="create"`) to initialize the campaign structure in the system. Define the title, type, budget, and description.
4. **Create ICP List for Enrichment:** First, use `getFinderCategoryIds` to obtain valid IDs for locations, industries, or skills. Then, use the `createIcpMining` tool to trigger the generation of a detailed Ideal Customer Profile list based on those IDs and role descriptions.
5. **Draft Sequence Copy:** Use the `copywriting` tool (`action="create"`) to write the outreach sequence copy. Create separate entries for the initial outreach and follow-ups. Ensure the messaging is tailored to the ICP and optimized for the specific outbound channel being used (`copy_type`).
6. **Report Status:** Document all the created assets (campaign IDs, ICP mining run details, copywriting template IDs) and the channel verification status. Update the `requirement_status` so the user can review the created records.

## Tools

| Tool | When to use |
| --- | --- |
| `configure_whatsapp` | Use `action="get_config"` to verify if a WhatsApp outbound channel is configured before proceeding. |
| `configure_email` | Use to verify if an email outbound channel is available if WhatsApp is not used. |
| `segments` | Use `action="list"` to review existing audience segments and `action="update"` to depurate or adjust segment parameters. |
| `campaigns` | Use `action="create"` to initialize the outbound campaign structure in the system with goals and associated segments. |
| `getFinderCategoryIds` | Use to retrieve the correct IDs for industries, locations, or skills before creating the ICP mining run. |
| `createIcpMining` | Use to generate the Ideal Customer Profile (ICP) list for data enrichment by passing the targeted role and the IDs obtained from `getFinderCategoryIds`. |
| `copywriting` | Use `action="create"` to draft and save the sequence copy (e.g., WhatsApp messages or Emails) tailored to the ICP. |
| `requirements` | Read the initial requirement instructions and append structured campaign details. |
| `requirement_status` | Publish the progress and final delivery status. |

## Artifacts

- **Produces**: Marketing copy entries (via `copywriting`), new outbound campaign entries (via `campaigns`), ICP mining runs (via `createIcpMining`).
- **Consumes**: `requirement.instructions` (for context on the campaign goals and target audience).
