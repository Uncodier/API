---
name: makinari-contract-adequation
description: Core directive for all Makinari agents (Orchestrator, Frontend, Backend, QA) defining the "Contract Adequation" protocol. It empowers agents to make proactive, reasonable decisions to complete features when the initial contract is missing details, rather than blocking the pipeline.
types: ['planning', 'develop', 'design', 'automation', 'integration']
---

# SKILL: makinari-contract-adequation

## Objective

The **Contract Adequation** protocol exists to solve the "Contract Drift" paralysis. In a rigid multi-agent system, agents often fail or block execution when a minor detail (e.g., a missing `data-testid`, an unspecified loading state, or an incomplete API response shape) is absent from the `requirement.instructions`.

This skill authorizes and instructs all agents to prioritize **functionality and completeness** over strict, blocking adherence to an incomplete contract. Agents must make reasonable, industry-standard decisions to fill the gaps, complete their task, and explicitly report these additions back to the Orchestrator.

## Core Principles

1. **Do not block on minor gaps:** If a detail is missing but its intent is clear, do not halt execution to ask the Orchestrator. Build it.
2. **Use Industry Standards:** When inventing a missing piece (a field, an endpoint, a UI state), use standard conventions (e.g., `isLoading`, standard REST paths, common UI patterns).
3. **Explicit Traceability:** Every proactive decision MUST be documented in the step's output using the `[CONTRACT ADEQUATION]` flag. This ensures stability and allows other agents to sync with the new reality.

## How to Apply Contract Adequation by Role

### Frontend (`makinari-rol-frontend`)
- **Missing `data-testid`s:** If you need a new element to make the UI functional (e.g., an error message container, a loading spinner, a cancel button) that is not in section 6.4 of the requirement, **create it**. Assign it a logical `data-testid`.
- **Missing Endpoints:** If a form needs to submit data but the backend endpoint isn't defined in the contract, wire the form to the logical endpoint path (e.g., `POST /api/contact`) and handle the expected response.
- **Reporting:** In your `step_output`, include: 
  `[CONTRACT ADEQUATION]: Added data-testid 'submit-error-msg' for error handling. Wired form to assumed endpoint POST /api/contact.`

### Backend (`makinari-rol-backend`)
- **Missing Fields/Properties:** If the DB schema or API response in section 6.1/6.2 lacks a field necessary for the feature to work (e.g., a `createdAt` timestamp, a `status` flag), **add it**.
- **Missing Endpoints:** If you realize a feature requires a helper endpoint (e.g., fetching a list of options for a dropdown) that wasn't requested, **build it**.
- **Reporting:** In your `step_output`, include:
  `[CONTRACT ADEQUATION]: Added 'status' field to the DB schema and API response to support the UI filtering logic. Created helper endpoint GET /api/options.`

### Orchestrator (`makinari-rol-orchestrator`)
- **Acceptance:** When reviewing a sub-agent's `step_output`, scan for the `[CONTRACT ADEQUATION]` flag. Do NOT treat these as errors or hallucinations.
- **Synchronization:** Immediately update the master `requirement.instructions` (using `requirements action="update"`) to include the new test-ids, endpoints, or DB fields reported by the sub-agents. This ensures the next agent in the pipeline (e.g., QA or Backend) works with the updated, adequate contract.

## The Adequation Flow

1. **Detection:** An agent notices a gap in the contract that prevents logical completion of the feature.
2. **Proactive Action:** The agent implements the missing piece using best practices.
3. **Report:** The agent finishes its step and includes the `[CONTRACT ADEQUATION]` block in its `step_output`.
4. **Sync:** The Orchestrator reads the output, updates the central `requirement.instructions`, and the pipeline continues smoothly.

## Anti-patterns (When NOT to use this)

- **Major Scope Creep:** Do not use Contract Adequation to build entirely new features (e.g., adding a full Admin Dashboard when the requirement was just a Contact Form).
- **Silent Changes:** Never add a field or test-id without reporting it with the `[CONTRACT ADEQUATION]` flag. Silent changes break QA and downstream agents.
- **Destructive Changes:** You can *add* to the contract, but you should avoid *removing* or *renaming* items already explicitly defined in the contract, as other agents might already depend on them.
