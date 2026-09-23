const mockFrom = jest.fn()
const mockDecryptToken = jest.fn()

jest.mock("@/lib/database/supabase-server", () => ({
  supabaseAdmin: { from: mockFrom },
}))

jest.mock("@/lib/utils/token-decryption", () => ({
  decryptToken: mockDecryptToken,
}))

import { resolveAgentMailWebhookVerificationContext } from "../site-webhook-secret"

function queryReturning(result: unknown) {
  const query = {
    select: jest.fn(),
    filter: jest.fn(),
    limit: jest.fn(),
    maybeSingle: jest.fn().mockResolvedValue(result),
    eq: jest.fn(),
    is: jest.fn(),
  }
  query.select.mockReturnValue(query)
  query.filter.mockReturnValue(query)
  query.limit.mockReturnValue(query)
  query.eq.mockReturnValue(query)
  query.is.mockReturnValue(query)
  return query
}

describe("resolveAgentMailWebhookVerificationContext", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("uses the site webhook secret associated with the inbox", async () => {
    mockFrom
      .mockReturnValueOnce(queryReturning({ data: { site_id: "site-1" }, error: null }))
      .mockReturnValueOnce(queryReturning({
        data: { encrypted_value: "encrypted-secret" },
        error: null,
      }))
    mockDecryptToken.mockReturnValue("whsec_site")

    const result = await resolveAgentMailWebhookVerificationContext(
      JSON.stringify({ message: { inbox_id: "support@example.com" } }),
      "whsec_global",
    )

    expect(result).toEqual({ secret: "whsec_site", siteId: "site-1" })
    expect(mockFrom).toHaveBeenNthCalledWith(1, "settings")
    expect(mockFrom).toHaveBeenNthCalledWith(2, "site_secrets")
  })

  it("keeps the global secret for inboxes without a site-specific secret", async () => {
    mockFrom
      .mockReturnValueOnce(queryReturning({ data: { site_id: "site-1" }, error: null }))
      .mockReturnValueOnce(queryReturning({ data: null, error: null }))

    const result = await resolveAgentMailWebhookVerificationContext(
      JSON.stringify({ message: { inbox_id: "support@example.com" } }),
      "whsec_global",
    )

    expect(result).toEqual({ secret: "whsec_global", siteId: "site-1" })
    expect(mockDecryptToken).not.toHaveBeenCalled()
  })

  it("does not query Vault for a malformed payload", async () => {
    const result = await resolveAgentMailWebhookVerificationContext(
      "not-json",
      "whsec_global",
    )

    expect(result).toEqual({ secret: "whsec_global", siteId: null })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it("fails closed when a stored secret cannot be decrypted", async () => {
    mockFrom
      .mockReturnValueOnce(queryReturning({ data: { site_id: "site-1" }, error: null }))
      .mockReturnValueOnce(queryReturning({
        data: { encrypted_value: "invalid" },
        error: null,
      }))
    mockDecryptToken.mockReturnValue(null)

    const result = await resolveAgentMailWebhookVerificationContext(
      JSON.stringify({ message: { inbox_id: "support@example.com" } }),
      "whsec_global",
    )

    expect(result).toEqual({ secret: null, siteId: "site-1" })
  })
})
