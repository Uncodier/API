const mockGetUser = jest.fn();
const mockRpc = jest.fn();
const mockMaybeSingle = jest.fn();
const mockEq = jest.fn();
const mockSelect = jest.fn();
const mockFrom = jest.fn();
const mockCreateSupabaseClient = jest.fn();
const mockDeleteSender = jest.fn();
const mockDetachSender = jest.fn();
const mockReleaseNumber = jest.fn();

jest.mock("@/lib/database/supabase-server", () => ({
  createSupabaseClient: mockCreateSupabaseClient,
  get supabaseAdmin() { throw new Error("Privileged settings access is forbidden"); },
}));
jest.mock("@/lib/services/zavu", () => ({
  deleteSender: mockDeleteSender,
  detachSenderFromAgent: mockDetachSender,
  releaseNumber: mockReleaseNumber,
}));

import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { DELETE, GET } from "../route";

const SITE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER_SITE_ID = "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SENDER_ID = "sender_12345";
const NUMBER = "+14155550100";
const VOICE_NUMBER = "+14155550199";

function request(siteId: string | null = SITE_ID, headers?: HeadersInit) {
  const url = new URL(`https://api.example.invalid/api/integrations/zavu/senders/${SENDER_ID}`);
  if (siteId !== null) url.searchParams.set("siteId", siteId);
  return new NextRequest(url, { headers });
}

function params(id = SENDER_ID) {
  return { params: Promise.resolve({ id }) };
}

function connected(patch: Record<string, unknown> = {}) {
  return { type: "whatsapp", status: "connected", zavu_sender_id: SENDER_ID, ...patch };
}

function settings(connections: unknown[] = [connected()], siteId = SITE_ID) {
  return { data: { site_id: siteId, channels: { connections } }, error: null };
}

function providerSender(patch: Record<string, unknown> = {}) {
  return {
    id: SENDER_ID,
    name: "WhatsApp channel",
    phoneNumber: VOICE_NUMBER,
    whatsapp: { displayPhoneNumber: NUMBER },
    ...patch,
  };
}

describe("GET Zavu WhatsApp sender display", () => {
  let fetchSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let timeoutSpy: jest.SpyInstance;
  const originalKey = process.env.ZAVUDEV_API_KEY;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env.ZAVUDEV_API_KEY = randomBytes(24).toString("hex");
    fetchSpy = jest.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(providerSender()));
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    timeoutSpy = jest.spyOn(AbortSignal, "timeout");
    mockGetUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
    mockRpc.mockResolvedValue({ data: "member", error: null });
    mockMaybeSingle.mockResolvedValue(settings());
    mockEq.mockReturnValue({ maybeSingle: mockMaybeSingle });
    mockSelect.mockReturnValue({ eq: mockEq });
    mockFrom.mockImplementation((table) => {
      if (table !== "settings") throw new Error("Unexpected table");
      return { select: mockSelect };
    });
    mockCreateSupabaseClient.mockReturnValue({
      auth: { getUser: mockGetUser }, rpc: mockRpc, from: mockFrom,
    });
  });

  afterEach(() => {
    expect(mockDeleteSender).not.toHaveBeenCalled();
    expect(mockDetachSender).not.toHaveBeenCalled();
    expect(mockReleaseNumber).not.toHaveBeenCalled();
    jest.restoreAllMocks();
    if (originalKey === undefined) delete process.env.ZAVUDEV_API_KEY;
    else process.env.ZAVUDEV_API_KEY = originalKey;
  });

  it("authorizes a member, reads only site-scoped settings, and returns a minimal secret-free DTO", async () => {
    const secrets = Array.from({ length: 5 }, () => randomBytes(24).toString("hex"));
    const webhookUrl = new URL("https://webhook.example.invalid/events");
    webhookUrl.password = secrets[4];
    webhookUrl.username = "synthetic-user";
    fetchSpy.mockResolvedValue(Response.json(providerSender({
      webhook: { secret: secrets[0], url: webhookUrl.toString() },
      apiKey: secrets[1],
      token: secrets[2],
      whatsapp: { displayPhoneNumber: NUMBER, accessToken: secrets[3], phoneNumberId: "meta_123" },
    })));
    mockMaybeSingle.mockResolvedValue(settings([connected({
      enabled: true, metadata: { zavu_webhook_secret: secrets[0] },
    })]));
    const req = request();
    const response = await GET(req, params());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(body).toEqual({
      success: true, data: { id: SENDER_ID, whatsapp: { displayPhoneNumber: NUMBER } },
    });
    for (const secret of secrets) expect(JSON.stringify(body)).not.toContain(secret);
    expect(JSON.stringify(body)).not.toContain(VOICE_NUMBER);
    expect(mockCreateSupabaseClient).toHaveBeenCalledTimes(2);
    expect(mockCreateSupabaseClient).toHaveBeenNthCalledWith(1, req);
    expect(mockCreateSupabaseClient).toHaveBeenNthCalledWith(2, req);
    expect(mockRpc).toHaveBeenCalledWith("current_user_site_role", { p_site_id: SITE_ID });
    expect(mockFrom).toHaveBeenCalledTimes(1);
    expect(mockFrom).toHaveBeenCalledWith("settings");
    expect(mockSelect).toHaveBeenCalledWith("site_id, channels");
    expect(mockEq).toHaveBeenCalledWith("site_id", SITE_ID);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(`https://api.zavu.dev/v1/senders/${SENDER_ID}`, {
      method: "GET", redirect: "error", cache: "no-store", signal: expect.any(AbortSignal),
      headers: { Authorization: `Bearer ${process.env.ZAVUDEV_API_KEY}`, "Content-Type": "application/json" },
    });
    expect(timeoutSpy).toHaveBeenCalledWith(8_000);
    expect(mockGetUser.mock.invocationCallOrder[0]).toBeLessThan(mockRpc.mock.invocationCallOrder[0]);
    expect(mockRpc.mock.invocationCallOrder[0]).toBeLessThan(mockFrom.mock.invocationCallOrder[0]);
    expect(mockMaybeSingle.mock.invocationCallOrder[0]).toBeLessThan(fetchSpy.mock.invocationCallOrder[0]);
  });

  it.each([null, "", "not-a-uuid", `${SITE_ID}/other`])("rejects invalid siteId %p before IO", async (siteId) => {
    const response = await GET(request(siteId), params());
    expect(response.status).toBe(400);
    expect(mockCreateSupabaseClient).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects duplicate siteId query parameters", async () => {
    const req = request();
    req.nextUrl.searchParams.append("siteId", OTHER_SITE_ID);
    expect((await GET(req, params())).status).toBe(400);
    expect(mockCreateSupabaseClient).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(["", " ", "../sender", "sender/id", "sender%2Fid", "sender?id=other", "sender#id",
    "sender\\id", "sender.id", "sender\nid", "sender\n", "sender\r", "sender\u0000", "senderé",
    "-sender", "_sender", "a".repeat(129), undefined, null, 123])(
    "rejects malformed sender ID %p before IO", async (id) => {
      const response = await GET(request(), { params: Promise.resolve({ id: id as string }) });
      expect(response.status).toBe(400);
      expect(mockCreateSupabaseClient).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  );

  it.each(["sender_A-123", "a".repeat(128)])("accepts bounded safe sender ID %p", async (id) => {
    mockMaybeSingle.mockResolvedValue(settings([connected({ zavu_sender_id: id })]));
    fetchSpy.mockResolvedValue(Response.json(providerSender({ id })));
    expect((await GET(request(), params(id))).status).toBe(200);
  });

  it("normalizes a valid uppercase site UUID before authorization and settings lookup", async () => {
    expect((await GET(request(SITE_ID.toUpperCase()), params())).status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith("current_user_site_role", { p_site_id: SITE_ID });
    expect(mockEq).toHaveBeenCalledWith("site_id", SITE_ID);
  });

  it("rejects unauthenticated users before querying roles, settings or Zavu", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: new Error(randomBytes(24).toString("hex")) });
    const response = await GET(request(), params());
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("waits for site authorization to resolve before reading settings or calling Zavu", async () => {
    let authorize!: (value: { data: string; error: null }) => void;
    mockRpc.mockReturnValue(new Promise((resolve) => { authorize = resolve; }));
    const response = GET(request(), params());
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockFrom).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    authorize({ data: "member", error: null });
    expect((await response).status).toBe(200);
  });

  it.each([{ data: null, error: null }, { data: "member", error: new Error("Unavailable") }])(
    "rejects unauthorized or unverifiable site access before settings or Zavu", async (role) => {
      mockRpc.mockResolvedValue(role);
      const response = await GET(request(), params());
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: "Forbidden" });
      expect(mockFrom).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  );

  it("rejects service-role API-key metadata before creating any client", async () => {
    const response = await GET(request(SITE_ID, { "x-api-key-data": "{}" }), params());
    expect(response.status).toBe(401);
    expect(mockCreateSupabaseClient).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a sender attached only to another site", async () => {
    const rows = { [SITE_ID]: settings([]), [OTHER_SITE_ID]: settings() };
    mockEq.mockImplementation((_column, siteId: string) => ({
      maybeSingle: () => Promise.resolve(rows[siteId as keyof typeof rows]),
    }));
    const response = await GET(request(), params());
    expect(response.status).toBe(404);
    expect(mockEq).toHaveBeenCalledTimes(1);
    expect(mockEq).toHaveBeenCalledWith("site_id", SITE_ID);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    { type: "voice" }, { type: "messenger" }, { status: "pending" }, { status: "disconnected" },
    { status: "failed" }, { status: "inactive" }, { enabled: false }, { enabled: "true" },
    { zavu_sender_id: "sender_other" }, { zavu_sender_id: undefined, metadata: { sender_id: SENDER_ID } },
  ])("rejects a non-active or mismatched WhatsApp connection %p", async (patch) => {
    mockMaybeSingle.mockResolvedValue(settings([connected(patch)]));
    expect((await GET(request(), params())).status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    { data: null, error: null },
    { data: { site_id: SITE_ID, channels: null }, error: null },
    { data: { site_id: SITE_ID, channels: { connections: {} } }, error: null },
    settings([null, "invalid", []]), settings([], SITE_ID), settings([connected()], OTHER_SITE_ID),
  ])("fails closed on missing, malformed or mismatched settings %p", async (row) => {
    mockMaybeSingle.mockResolvedValue(row);
    expect((await GET(request(), params())).status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not call Zavu or leak a database error when settings cannot be read", async () => {
    const secret = randomBytes(24).toString("hex");
    mockMaybeSingle.mockResolvedValue({ data: settings().data, error: new Error(secret) });
    const response = await GET(request(), params());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(secret);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([undefined, null, {}, { displayPhoneNumber: null }, { displayPhoneNumber: "" },
    { displayPhoneNumber: "   " }, { phoneNumber: NUMBER }, { display_phone_number: NUMBER }])(
    "returns null when the WhatsApp display number is absent: %p", async (whatsapp) => {
      fetchSpy.mockResolvedValue(Response.json(providerSender({ whatsapp })));
      const response = await GET(request(), params());
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        success: true, data: { id: SENDER_ID, whatsapp: { displayPhoneNumber: null } },
      });
    }
  );

  it.each([null, [], {}, { sender: providerSender() }, { id: "sender_other" }, { id: 123 },
    providerSender({ whatsapp: "invalid" }), providerSender({ whatsapp: { displayPhoneNumber: 123 } }),
    providerSender({ whatsapp: { displayPhoneNumber: "x".repeat(65) } })])(
    "rejects missing, malformed or mismatched provider sender %p", async (sender) => {
      fetchSpy.mockResolvedValue(Response.json(sender));
      const response = await GET(request(), params());
      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toEqual({ error: "Failed to retrieve WhatsApp sender" });
    }
  );

  it.each([301, 400, 401, 403, 404, 429, 500, 503])("sanitizes upstream HTTP %i without logging provider secrets", async (status) => {
    const secret = randomBytes(24).toString("hex");
    fetchSpy.mockResolvedValue(Response.json({ message: secret }, { status }));
    const response = await GET(request(), params());
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "Failed to retrieve WhatsApp sender" });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it.each(["TimeoutError", "TypeError"])("sanitizes provider %s failures", async (name) => {
    const secret = randomBytes(24).toString("hex");
    fetchSpy.mockRejectedValue(Object.assign(new Error(secret), { name }));
    const response = await GET(request(), params());
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(secret);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("fails closed on a non-JSON provider success", async () => {
    fetchSpy.mockResolvedValue(new Response("not JSON"));
    expect((await GET(request(), params())).status).toBe(502);
  });

  it("returns a sanitized gateway error when the provider deadline aborts the fetch", async () => {
    const controller = new AbortController();
    timeoutSpy.mockReturnValue(controller.signal);
    fetchSpy.mockImplementation((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    }));
    const response = GET(request(), params());
    await new Promise((resolve) => setImmediate(resolve));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    controller.abort(new DOMException("Synthetic deadline reached", "TimeoutError"));
    expect((await response).status).toBe(502);
    expect(timeoutSpy).toHaveBeenCalledWith(8_000);
  });

  it("does not disclose missing provider configuration", async () => {
    delete process.env.ZAVUDEV_API_KEY;
    const response = await GET(request(), params());
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "Failed to retrieve WhatsApp sender" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("DELETE Zavu sender compatibility", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockDetachSender.mockResolvedValue(undefined);
    mockDeleteSender.mockResolvedValue(undefined);
    mockReleaseNumber.mockResolvedValue(undefined);
  });

  it("preserves detach, optional release, then delete without new GET authorization", async () => {
    const req = request(null);
    req.nextUrl.searchParams.set("phoneNumber", VOICE_NUMBER);
    const response = await DELETE(req, params());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, message: "Sender deleted" });
    expect(mockDetachSender).toHaveBeenCalledWith(SENDER_ID);
    expect(mockReleaseNumber).toHaveBeenCalledWith(VOICE_NUMBER);
    expect(mockDeleteSender).toHaveBeenCalledWith(SENDER_ID);
    expect(mockDetachSender.mock.invocationCallOrder[0]).toBeLessThan(mockReleaseNumber.mock.invocationCallOrder[0]);
    expect(mockReleaseNumber.mock.invocationCallOrder[0]).toBeLessThan(mockDeleteSender.mock.invocationCallOrder[0]);
    expect(mockCreateSupabaseClient).not.toHaveBeenCalled();
  });

  it("preserves deletion without a number", async () => {
    expect((await DELETE(request(null), params())).status).toBe(200);
    expect(mockReleaseNumber).not.toHaveBeenCalled();
    expect(mockDeleteSender).toHaveBeenCalledWith(SENDER_ID);
  });
});