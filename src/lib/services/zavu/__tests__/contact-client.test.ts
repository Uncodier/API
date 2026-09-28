const mockZavuFetch = jest.fn();

jest.mock("../client", () => ({
  zavuFetch: mockZavuFetch,
}));

import {
  clearVoiceCallContactContext,
  setVoiceCallContactContext,
  VOICE_CONTEXT_METADATA_KEYS,
} from "../contact-client";

const phone = "+14155550100";
const lookupPath = "/contacts/phone/%2B14155550100";
const listPath = "/contacts?limit=100";

function notFound() {
  return Object.assign(new Error("Contact not found"), { status: 404 });
}

function voiceContact(id: string, deliveryId = "delivery-1") {
  return {
    id,
    channels: [{ channel: "voice", identifier: phone, isPrimary: true }],
    metadata: {
      customerTier: "gold",
      [VOICE_CONTEXT_METADATA_KEYS.deliveryId]: deliveryId,
      [VOICE_CONTEXT_METADATA_KEYS.objective]: "Old objective",
    },
  };
}

function writes() {
  return mockZavuFetch.mock.calls.filter(([, init]) => init?.method);
}

describe("Zavu Voice contact context", () => {
  beforeEach(() => {
    mockZavuFetch.mockReset();
  });

  it("replaces stale Voice guidance while preserving unrelated metadata", async () => {
    mockZavuFetch
      .mockResolvedValueOnce({
        id: "contact-1",
        metadata: {
          customerTier: "gold",
          [VOICE_CONTEXT_METADATA_KEYS.deliveryId]: "old-delivery",
          [VOICE_CONTEXT_METADATA_KEYS.objective]: "Old objective",
        },
      })
      .mockResolvedValueOnce({ items: [], nextCursor: null })
      .mockResolvedValueOnce({ id: "contact-1" });

    await setVoiceCallContactContext({
      phone: "+14155550100",
      deliveryId: "delivery-1",
      siteId: "site-1",
      objective: "Confirm the appointment",
      additionalContext: "Offer the afternoon slot.",
      followUpContext: "Previous call: requested an afternoon appointment.",
    });

    expect(mockZavuFetch).toHaveBeenNthCalledWith(
      3,
      "/contacts/contact-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          metadata: {
            customerTier: "gold",
            [VOICE_CONTEXT_METADATA_KEYS.deliveryId]: "delivery-1",
            [VOICE_CONTEXT_METADATA_KEYS.siteId]: "site-1",
            [VOICE_CONTEXT_METADATA_KEYS.objective]: "Confirm the appointment",
            [VOICE_CONTEXT_METADATA_KEYS.additionalContext]:
              "Offer the afternoon slot.",
            [VOICE_CONTEXT_METADATA_KEYS.followUpContext]:
              "Previous call: requested an afternoon appointment.",
          },
        }),
      })
    );
  });

  it("clears only the guidance owned by the completed delivery", async () => {
    mockZavuFetch
      .mockResolvedValueOnce({
        id: "contact-1",
        metadata: {
          customerTier: "gold",
          [VOICE_CONTEXT_METADATA_KEYS.deliveryId]: "delivery-1",
          [VOICE_CONTEXT_METADATA_KEYS.objective]: "Confirm the appointment",
        },
      })
      .mockResolvedValueOnce({ items: [], nextCursor: null })
      .mockResolvedValueOnce({ id: "contact-1" });

    await clearVoiceCallContactContext({
      phone: "+14155550100",
      deliveryId: "delivery-1",
    });

    expect(mockZavuFetch).toHaveBeenNthCalledWith(
      3,
      "/contacts/contact-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          metadata: {
            customerTier: "gold",
            [VOICE_CONTEXT_METADATA_KEYS.deliveryId]: "",
            [VOICE_CONTEXT_METADATA_KEYS.siteId]: "",
            [VOICE_CONTEXT_METADATA_KEYS.objective]: "",
            [VOICE_CONTEXT_METADATA_KEYS.additionalContext]: "",
            [VOICE_CONTEXT_METADATA_KEYS.followUpContext]: "",
          },
        }),
      })
    );
  });

  it("does not clear context belonging to a newer delivery", async () => {
    mockZavuFetch
      .mockResolvedValueOnce({
        id: "contact-1",
        metadata: {
          [VOICE_CONTEXT_METADATA_KEYS.deliveryId]: "delivery-2",
        },
      })
      .mockResolvedValueOnce({ items: [], nextCursor: null });

    await clearVoiceCallContactContext({
      phone: "+14155550100",
      deliveryId: "delivery-1",
    });

    expect(mockZavuFetch).toHaveBeenCalledTimes(2);
    expect(writes()).toHaveLength(0);
  });

  it("treats a missing contact as an expected lookup when clearing context", async () => {
    mockZavuFetch
      .mockRejectedValueOnce(notFound())
      .mockResolvedValueOnce({ items: [], nextCursor: null });

    await expect(clearVoiceCallContactContext({
      phone: "+14155550100",
      deliveryId: "call-1",
    })).resolves.toBeUndefined();
    expect(mockZavuFetch).toHaveBeenCalledWith(
      lookupPath, expect.objectContaining({ signal: expect.any(AbortSignal) }),
      { silentStatuses: [404] }
    );
    expect(mockZavuFetch).toHaveBeenCalledTimes(2);
    expect(writes()).toHaveLength(0);
  });

  it("reuses a Voice-only contact on a later page instead of creating a duplicate", async () => {
    const cursor = "opaque+/= page";
    mockZavuFetch
      .mockRejectedValueOnce(notFound())
      .mockResolvedValueOnce({
        items: [voiceContact("other-phone")].map((contact) => ({
          ...contact,
          channels: [{ channel: "voice", identifier: "+4414155550100" }],
        })),
        nextCursor: cursor,
      })
      .mockResolvedValueOnce({ items: [voiceContact("voice-only")], nextCursor: null })
      .mockResolvedValueOnce({ id: "voice-only" });

    await setVoiceCallContactContext({ phone, deliveryId: "delivery-1", siteId: "site-1" });

    expect(mockZavuFetch).toHaveBeenNthCalledWith(
      3, `${listPath}&cursor=${encodeURIComponent(cursor).replace(/%20/g, "+")}`,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(writes()).toEqual([
      ["/contacts/voice-only", expect.objectContaining({ method: "PATCH" })],
    ]);
    expect(JSON.parse(writes()[0][1].body).metadata).toMatchObject({
      customerTier: "gold",
      [VOICE_CONTEXT_METADATA_KEYS.deliveryId]: "delivery-1",
      [VOICE_CONTEXT_METADATA_KEYS.siteId]: "site-1",
    });
  });

  it.each([false, true])("prefers an existing owner regardless of list order (reverse: %s)", async (reverse) => {
    const contacts = [voiceContact("a-contact", "other-delivery"), voiceContact("z-owner")];
    mockZavuFetch
      .mockResolvedValueOnce(voiceContact("legacy", "old-delivery"))
      .mockResolvedValueOnce({ items: reverse ? contacts.reverse() : contacts, nextCursor: null })
      .mockResolvedValueOnce({ id: "z-owner" });

    await setVoiceCallContactContext({ phone, deliveryId: "delivery-1", siteId: "site-1" });

    expect(writes().map(([path]) => path)).toEqual(["/contacts/z-owner"]);
  });

  it.each([false, true])("selects a stable contact among unowned duplicates (reverse: %s)", async (reverse) => {
    const contacts = [voiceContact("z-contact", ""), voiceContact("a-contact", "")];
    mockZavuFetch
      .mockRejectedValueOnce(notFound())
      .mockResolvedValueOnce({ items: reverse ? contacts.reverse() : contacts, nextCursor: null })
      .mockResolvedValueOnce({ id: "a-contact" });

    await setVoiceCallContactContext({ phone, deliveryId: "delivery-1", siteId: "site-1" });

    expect(writes().map(([path]) => path)).toEqual(["/contacts/a-contact"]);
  });

  it("cleans every owned duplicate across pages, including a successful legacy lookup", async () => {
    const legacy = voiceContact("legacy");
    mockZavuFetch
      .mockResolvedValueOnce(legacy)
      .mockResolvedValueOnce({
        items: [legacy, voiceContact("voice-only")], nextCursor: "page-2",
      })
      .mockResolvedValueOnce({
        items: [voiceContact("another-owned"), voiceContact("newer", "delivery-2")],
        nextCursor: null,
      })
      .mockImplementation(async (path: string) => ({ id: path.split("/").pop() }));

    await clearVoiceCallContactContext({ phone, deliveryId: "delivery-1" });

    expect(writes().map(([path]) => path).sort()).toEqual([
      "/contacts/another-owned", "/contacts/legacy", "/contacts/voice-only",
    ]);
    for (const [, init] of writes()) {
      expect(JSON.parse(init.body)).toEqual({
        metadata: {
          customerTier: "gold",
          ...Object.fromEntries(Object.values(VOICE_CONTEXT_METADATA_KEYS).map((key) => [key, ""])),
        },
      });
    }
  });

  it("does not match phone suffixes, other channel types or primaryPhone in the list", async () => {
    const contacts = [
      { ...voiceContact("different-country"), channels: [{ channel: "voice", identifier: "+4414155550100" }] },
      { ...voiceContact("email"), channels: [{ channel: "email", identifier: phone }] },
      { ...voiceContact("sms"), channels: [{ channel: "sms", identifier: phone }] },
      { ...voiceContact("primary-only"), primaryPhone: phone, channels: [] },
    ];
    mockZavuFetch
      .mockRejectedValueOnce(notFound())
      .mockResolvedValueOnce({ items: contacts, nextCursor: null });

    await clearVoiceCallContactContext({ phone, deliveryId: "delivery-1" });

    expect(writes()).toHaveLength(0);
  });

  it("creates only after a complete empty lookup and keeps the Voice channel contract", async () => {
    mockZavuFetch
      .mockRejectedValueOnce(notFound())
      .mockResolvedValueOnce({ items: [], nextCursor: "page-2" })
      .mockResolvedValueOnce({ items: [], nextCursor: null })
      .mockResolvedValueOnce({ contact: { id: "created" } });

    await setVoiceCallContactContext({ phone, deliveryId: "delivery-1", siteId: "site-1" });

    expect(mockZavuFetch).toHaveBeenCalledTimes(4);
    expect(writes()).toEqual([["/contacts", expect.objectContaining({ method: "POST" })]]);
    expect(JSON.parse(writes()[0][1].body)).toMatchObject({
      channels: [{ channel: "voice", identifier: phone, isPrimary: true }],
      metadata: {
        [VOICE_CONTEXT_METADATA_KEYS.deliveryId]: "delivery-1",
        [VOICE_CONTEXT_METADATA_KEYS.siteId]: "site-1",
      },
    });
  });

  it("rescans Voice channels after a create conflict", async () => {
    mockZavuFetch
      .mockRejectedValueOnce(notFound())
      .mockResolvedValueOnce({ items: [], nextCursor: null })
      .mockRejectedValueOnce(Object.assign(new Error("Duplicate identifier"), { status: 400 }))
      .mockRejectedValueOnce(notFound())
      .mockResolvedValueOnce({ items: [voiceContact("raced-contact")], nextCursor: null })
      .mockResolvedValueOnce({ id: "raced-contact" });

    await setVoiceCallContactContext({ phone, deliveryId: "delivery-1", siteId: "site-1" });

    expect(writes().map(([path, init]) => [path, init.method])).toEqual([
      ["/contacts", "POST"], ["/contacts/raced-contact", "PATCH"],
    ]);
  });

  it("preserves a create error when rescanning finds no matching contact", async () => {
    const error = Object.assign(new Error("Invalid request"), { status: 400 });
    mockZavuFetch
      .mockRejectedValueOnce(notFound())
      .mockResolvedValueOnce({ items: [], nextCursor: null })
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(notFound())
      .mockResolvedValueOnce({ items: [], nextCursor: null });

    await expect(setVoiceCallContactContext({
      phone, deliveryId: "delivery-1", siteId: "site-1",
    })).rejects.toBe(error);
    expect(writes()).toHaveLength(1);
  });

  it.each([401, 429, 503])("propagates phone lookup errors (%s) without creating contacts", async (status) => {
    const error = Object.assign(new Error("Provider unavailable"), { status });
    mockZavuFetch.mockRejectedValueOnce(error);

    await expect(setVoiceCallContactContext({
      phone, deliveryId: "delivery-1", siteId: "site-1",
    })).rejects.toBe(error);
    expect(mockZavuFetch).toHaveBeenCalledTimes(1);
    expect(writes()).toHaveLength(0);
  });

  it.each([404, 429, 503])("does not interpret a list failure (%s) as a missing contact", async (status) => {
    const error = Object.assign(new Error("List unavailable"), { status });
    mockZavuFetch.mockRejectedValueOnce(notFound()).mockRejectedValueOnce(error);

    await expect(setVoiceCallContactContext({
      phone, deliveryId: "delivery-1", siteId: "site-1",
    })).rejects.toBe(error);
    expect(writes()).toHaveLength(0);
  });

  it.each([
    {},
    { items: null },
    { items: [], nextCursor: 123 },
    { items: [{ id: "" }], nextCursor: null },
    { items: [{ id: "incomplete", availableChannels: ["voice"] }], nextCursor: null },
    { items: [{ id: "incomplete", availableChannels: [null] }], nextCursor: null },
    { items: [{ id: "incomplete", channels: [null] }], nextCursor: null },
    { items: [{ ...voiceContact("incomplete"), metadata: undefined }], nextCursor: null },
  ])("rejects malformed or incomplete list data without writing (%j)", async (page) => {
    mockZavuFetch.mockRejectedValueOnce(notFound()).mockResolvedValueOnce(page);

    await expect(setVoiceCallContactContext({
      phone, deliveryId: "delivery-1", siteId: "site-1",
    })).rejects.toThrow();
    expect(writes()).toHaveLength(0);
  });

  it("rejects repeated pagination cursors instead of writing from a partial scan", async () => {
    mockZavuFetch
      .mockRejectedValueOnce(notFound())
      .mockResolvedValueOnce({ items: [voiceContact("match")], nextCursor: "same" })
      .mockResolvedValueOnce({ items: [], nextCursor: "same" });

    await expect(clearVoiceCallContactContext({ phone, deliveryId: "delivery-1" })).rejects.toThrow(/pagination/i);
    expect(mockZavuFetch).toHaveBeenCalledTimes(3);
    expect(writes()).toHaveLength(0);
  });

  it("does not clear a partial result if a subsequent page fails", async () => {
    const error = new Error("Provider unavailable");
    mockZavuFetch
      .mockResolvedValueOnce(voiceContact("legacy"))
      .mockResolvedValueOnce({ items: [voiceContact("match")], nextCursor: "page-2" })
      .mockRejectedValueOnce(error);

    await expect(clearVoiceCallContactContext({ phone, deliveryId: "delivery-1" })).rejects.toBe(error);
    expect(writes()).toHaveLength(0);
  });

  it("uses one deadline for the lookup and refuses writes if it expires", async () => {
    const controller = new AbortController();
    const timeout = jest.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    mockZavuFetch
      .mockRejectedValueOnce(notFound())
      .mockImplementationOnce(async () => {
        controller.abort();
        return { items: [voiceContact("match")], nextCursor: "page-2" };
      });
    try {
      await expect(setVoiceCallContactContext({
        phone, deliveryId: "delivery-1", siteId: "site-1",
      })).rejects.toMatchObject({ name: "AbortError" });
      expect(timeout).toHaveBeenCalledTimes(1);
      expect(mockZavuFetch).toHaveBeenCalledTimes(2);
      expect(mockZavuFetch.mock.calls[0][1].signal).toBe(controller.signal);
      expect(mockZavuFetch.mock.calls[1][1].signal).toBe(controller.signal);
      expect(writes()).toHaveLength(0);
    } finally {
      timeout.mockRestore();
    }
  });

  it("reuses the initiated contact on answered and cleans it on completed when phone lookup always misses", async () => {
    const contacts: ReturnType<typeof voiceContact>[] = [];
    mockZavuFetch.mockImplementation(async (path: string, init: RequestInit = {}) => {
      if (path === lookupPath) throw notFound();
      if (path === listPath) return { items: contacts, nextCursor: null };
      const body = JSON.parse(init.body as string);
      if (path === "/contacts" && init.method === "POST") {
        const contact = { id: "created-voice", ...body };
        contacts.push(contact);
        return { contact };
      }
      if (path === "/contacts/created-voice" && init.method === "PATCH") {
        contacts[0].metadata = body.metadata;
        return contacts[0];
      }
      throw new Error(`Unexpected request ${path}`);
    });
    const params = { phone, deliveryId: "call-1", siteId: "site-1" };

    await setVoiceCallContactContext(params);
    await setVoiceCallContactContext(params);
    await clearVoiceCallContactContext(params);

    expect(contacts).toHaveLength(1);
    expect(writes().map(([, init]) => init.method)).toEqual(["POST", "PATCH", "PATCH"]);
    expect(contacts[0].metadata[VOICE_CONTEXT_METADATA_KEYS.deliveryId]).toBe("");
    expect(contacts[0].channels).toEqual([
      { channel: "voice", identifier: phone, isPrimary: true },
    ]);
  });

  it("accepts a terminal page with the optional nextCursor omitted", async () => {
    mockZavuFetch
      .mockRejectedValueOnce(notFound())
      .mockResolvedValueOnce({ items: [] });

    await expect(clearVoiceCallContactContext({ phone, deliveryId: "delivery-1" })).resolves.toBeUndefined();
    expect(writes()).toHaveLength(0);
  });

  it("prefers a Voice channel over a legacy SMS match when neither owns the call", async () => {
    mockZavuFetch
      .mockResolvedValueOnce({
        id: "a-sms", channels: [{ channel: "sms", identifier: phone }], metadata: {},
      })
      .mockResolvedValueOnce({ items: [voiceContact("z-voice", "")], nextCursor: null })
      .mockResolvedValueOnce({ id: "z-voice" });

    await setVoiceCallContactContext({ phone, deliveryId: "delivery-1", siteId: "site-1" });

    expect(writes().map(([path]) => path)).toEqual(["/contacts/z-voice"]);
  });

  it("cleans both Voice-only duplicates from the incident without touching a newer call", async () => {
    mockZavuFetch
      .mockRejectedValueOnce(notFound())
      .mockResolvedValueOnce({
        items: [voiceContact("initiated"), voiceContact("answered"), voiceContact("newer", "delivery-2")],
        nextCursor: null,
      })
      .mockImplementation(async (path: string) => ({ id: path.split("/").pop() }));

    await clearVoiceCallContactContext({ phone, deliveryId: "delivery-1" });

    expect(writes().map(([path]) => path)).toEqual(["/contacts/initiated", "/contacts/answered"]);
  });
});
