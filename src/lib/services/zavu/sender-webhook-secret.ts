import { encryptToken } from "@/lib/utils/token-encryption";
import { regenerateSenderWebhookSecret } from "./client";

export async function ensureEncryptedSenderWebhookSecret(params: {
  senderId: string;
  returnedSecret?: unknown;
  encryptedSecret?: unknown;
}): Promise<string> {
  if (
    typeof params.encryptedSecret === "string"
    && params.encryptedSecret.length > 0
  ) {
    return params.encryptedSecret;
  }

  const secret =
    typeof params.returnedSecret === "string" && params.returnedSecret.length > 0
      ? params.returnedSecret
      : await regenerateSenderWebhookSecret(params.senderId);
  return encryptToken(secret);
}
