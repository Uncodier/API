---
name: makinari-obj-api-integration
description: Objective skill for integrating Makinari APIs and MCP tools into a project. Use when a requirement backlog involves tracking scripts, lead/customer integrations, transaction systems, AI usage, or fetching content. Enforces default blog integration on landing pages.
types: ['integration', 'develop']
---

# SKILL: makinari-obj-api-integration

## Objective

Deliver Makinari API and MCP integrations within client projects. This skill applies whenever a requirement includes steps like adding tracking scripts, managing leads, recording sales, sending webhooks, invoking AI agents, or fetching content (e.g., blog posts) through the Makinari ecosystem.

## Core Rules

### 1. Mandatory Blog Integration on Landing Pages
Whenever you are building or updating a landing page (or an application that includes a landing page), you **MUST** integrate the Makinari Blog Posts API by default.
- Endpoint: `GET /api/public/posts?limit=3`
- Display a "Latest News" or "From the Blog" section.
- Ensure proper error handling and fallback UI if the site has no published posts.

### 2. Authentication Context
- **Client-Side (Browser)**: Requests to public endpoints (`/api/public/*` and `/api/visitors/*`) do not require an API key if they originate from an allowed domain (CORS `Origin`).
- **Server-Side / Tools**: Machine-to-machine requests to REST or MCP endpoints (e.g., `/api/agents/tools/*`) **require** a valid `x-api-key` or `Authorization: Bearer YOUR_API_KEY` header.

## Common Integrations

### Tracking & Analytics
Add the visitor tracking script or call the REST API on key user interactions.
- **Track Event**: `POST /api/visitors/track`
  - Body: `{ event_type: 'pageview'|'click'|'custom'|'purchase', site_id, visitor_id, url, properties }`
- **Identify Visitor**: `POST /api/visitors/identify` (Links anonymous visitor to a lead)
  - Body: `{ site_id, id: visitor_id, traits: { email, name, phone } }`

### Leads Management (MCP/REST Tool)
Manage leads automatically from forms or sign-ups.
- **Endpoints**: `POST /api/agents/tools/leads/[action]` (Actions: `create`, `get`, `update`, `qualify`, `identify`)
- **Create Lead Example**:
  ```http
  POST /api/agents/tools/leads/create
  Authorization: Bearer YOUR_API_KEY
  
  {
    "site_id": "SITE_ID",
    "name": "User Name",
    "email": "user@example.com",
    "status": "new",
    "origin": "website"
  }
  ```

### Sales & Transactions (MCP/REST Tool)
Record purchases or subscription events.
- **Endpoints**: `POST /api/agents/tools/sales/[action]` (Actions: `create`, `get`, `update`, `delete`)
- **Create Sale Example**:
  ```http
  POST /api/agents/tools/sales/create
  Authorization: Bearer YOUR_API_KEY
  
  {
    "site_id": "SITE_ID",
    "customer_id": "CUSTOMER_UUID",
    "product_ids": ["PRODUCT_UUID"],
    "total_amount": 99.00,
    "payment_method": "card",
    "status": "completed"
  }
  ```

### Blog / Content API
Fetch public blog content to render inside the app/landing page.
- **Endpoint**: `GET /api/public/posts?limit=10`
- **Auth**: No API Key required from client browser. If server-side, include API Key.
- **Response Shape**: `{ success: true, data: [ { id, title, description, text, published_at, assets } ] }`

## Available MCP Tools reference
When the requirement asks for broader AI tool use, remember these map to `/api/agents/tools/{toolName}/{action}`:
- `leads` (create, get, update, qualify, identify)
- `sales` (create, get, update, delete)
- `conversations` (manage chat threads)
- `messages` (send emails, internal notifications)
- `workflows` (trigger automations)

## Implementation Steps
1. **Identify the Scope**: Read the requirement. Determine which Makinari APIs are needed (Tracking, Leads, Content, etc.).
2. **Setup Env Vars**: Ensure the app has access to `NEXT_PUBLIC_MAKINARI_SITE_ID` and (for server code) `MAKINARI_API_KEY`.
3. **Build the Integration**: Write the fetch calls or SDK wrappers. Implement the "Blog on Landing" rule if a landing page is present.
4. **Test**: If possible, use `sandbox_run_command` with curl to verify the endpoints, passing the correct headers.