const mockEncryptToken = jest.fn();
const mockRegenerateSenderWebhookSecret = jest.fn();

jest.mock("@/lib/utils/token-encryption", () => ({
  encryptToken: mockEncryptToken,
}));
jest.mock("../client", () => ({
  regenerateSenderWebhookSecret: mockRegenerateSenderWebhookSecret,
}));

import { ensureEncryptedSenderWebhookSecret } from "../sender-webhook-secret";

describe("ensureEncryptedSenderWebhookSecret", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEncryptToken.mockImplementation(
      (secret: string) => `encrypted:${secret}`
    );
  });

  it("keeps a previously persisted encrypted secret", async () => {
    await expect(ensureEncryptedSenderWebhookSecret({
      senderId: "sender_1",
      encryptedSecret: "stored-ciphertext",
    })).resolves.toBe("stored-ciphertext");
    expect(mockRegenerateSenderWebhookSecret).not.toHaveBeenCalled();
  });

  it("encrypts the one-time secret returned when a sender is created", async () => {
    await expect(ensureEncryptedSenderWebhookSecret({
      senderId: "sender_1",
      returnedSecret: "whsec_created",
    })).resolves.toBe("encrypted:whsec_created");
    expect(mockRegenerateSenderWebhookSecret).not.toHaveBeenCalled();
  });

  it("regenerates a missing secret for an existing sender", async () => {
    mockRegenerateSenderWebhookSecret.mockResolvedValue("whsec_regenerated");

    await expect(ensureEncryptedSenderWebhookSecret({
      senderId: "sender_1",
    })).resolves.toBe("encrypted:whsec_regenerated");
    expect(mockRegenerateSenderWebhookSecret).toHaveBeenCalledWith("sender_1");
  });
});
