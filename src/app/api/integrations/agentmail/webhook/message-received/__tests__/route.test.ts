import { NextRequest } from "next/server"
import { randomBytes } from "node:crypto"

const mockResolveVerificationContext = jest.fn()
const mockVerifySvixWebhook = jest.fn()
const mockTelemetry = jest.fn()
const mockFindMessage = jest.fn()
jest.mock("@/lib/status/telemetry", () => ({ recordTelemetry: mockTelemetry }))

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
  findMessageByAgentMailId: mockFindMessage,
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
    mockTelemetry.mockResolvedValue(undefined)
  })

  it("verifies the request with the site-specific secret", async () => {
    const secret = randomBytes(32).toString('hex')
    mockResolveVerificationContext.mockResolvedValue({
      secret,
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
      secret,
    )
    expect(mockTelemetry).not.toHaveBeenCalled()
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
    expect(mockTelemetry).not.toHaveBeenCalled()
  })

  it("records only authenticated acknowledgements, not invalid signatures", async () => {
    mockResolveVerificationContext.mockResolvedValue({ secret: randomBytes(32).toString('hex'), siteId: 'site-1' })
    mockVerifySvixWebhook.mockResolvedValue({ type: 'event', event_type: 'message.received', message: { message_id: 'message-1' } })
    mockFindMessage.mockResolvedValue({ id: 'existing-message' })
    const response = await POST(requestWith({}))
    expect(response.status).toBe(200)
    expect(mockTelemetry).toHaveBeenCalledWith('integrations_agentmail', 'up', 'Authenticated AgentMail duplicate acknowledged', expect.any(Number))
  })

  it("records a processing failure only after signature and payload validation", async () => {
    mockResolveVerificationContext.mockResolvedValue({ secret: randomBytes(32).toString('hex'), siteId: 'site-1' })
    mockVerifySvixWebhook.mockResolvedValue({ type: 'event', event_type: 'message.received', message: { message_id: 'message-1' } })
    mockFindMessage.mockRejectedValue(new Error('Synthetic storage failure'))
    expect((await POST(requestWith({}))).status).toBe(500)
    expect(mockTelemetry).toHaveBeenCalledWith('integrations_agentmail', 'down', 'Authenticated AgentMail webhook processing failed', expect.any(Number))
  })
})
