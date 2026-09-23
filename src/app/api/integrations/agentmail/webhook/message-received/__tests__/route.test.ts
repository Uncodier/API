import { NextRequest } from "next/server"

const mockResolveVerificationContext = jest.fn()
const mockVerifySvixWebhook = jest.fn()

jest.mock("@/lib/integrations/agentmail/site-webhook-secret", () => ({
  resolveAgentMailWebhookVerificationContext: mockResolveVerificationContext,
}))

jest.mock("@/lib/integrations/agentmail/svix-verification", () => ({
  verifySvixWebhook: mockVerifySvixWebhook,
}))

jest.mock("@/lib/database/supabase-server", () => ({
  supabaseAdmin: { from: jest.fn() },
}))

jest.mock("@/lib/services/workflow-service", () => ({
  WorkflowService: { getInstance: jest.fn() },
}))

jest.mock("@/lib/integrations/agentmail/message-updater", () => ({
  findMessageByAgentMailId: jest.fn(),
}))

jest.mock("@/lib/services/conversation-service", () => ({
  ConversationService: { findExistingConversation: jest.fn() },
}))

import { POST } from "../route"

function requestWith(body: unknown) {
  return new NextRequest(
    "https://backend.example.com/api/integrations/agentmail/webhook/message-received",
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  )
}

describe("AgentMail message.received webhook verification", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("verifies the request with the site-specific secret", async () => {
    mockResolveVerificationContext.mockResolvedValue({
      secret: "whsec_site",
      siteId: "site-1",
    })
    mockVerifySvixWebhook.mockResolvedValue(null)
    const request = requestWith({
      type: "event",
      event_type: "message.received",
      message: { inbox_id: "support@example.com" },
    })

    const response = await POST(request)

    expect(response.status).toBe(401)
    expect(mockVerifySvixWebhook).toHaveBeenCalledWith(
      expect.stringContaining("support@example.com"),
      "whsec_site",
    )
  })

  it("fails closed when a stored secret cannot be loaded", async () => {
    mockResolveVerificationContext.mockResolvedValue({
      secret: null,
      siteId: "site-1",
    })

    const response = await POST(requestWith({
      type: "event",
      event_type: "message.received",
      message: { inbox_id: "support@example.com" },
    }))

    expect(response.status).toBe(503)
    expect(mockVerifySvixWebhook).not.toHaveBeenCalled()
  })
})
