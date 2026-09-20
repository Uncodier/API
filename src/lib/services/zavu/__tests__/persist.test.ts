const mockMaybeSingle = jest.fn();
const mockUpdateEq = jest.fn();
const mockUpdate = jest.fn((_payload: any) => ({ eq: mockUpdateEq }));

jest.mock("@/lib/database/supabase-server", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: mockMaybeSingle }),
      }),
      update: mockUpdate,
    }),
  },
}));

import {
  replaceChannelSenderReferences,
  upsertChannelConnection,
} from "../persist";

describe("replaceChannelSenderReferences", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateEq.mockResolvedValue({ error: null });
  });

  it("updates Voice and sibling SMS connections that share an obsolete sender", async () => {
    mockMaybeSingle.mockResolvedValue({
      data: {
        channels: {
          connections: [
            {
              id: "voice-1",
              type: "voice",
              zavu_sender_id: "sender_old",
              metadata: { sender_id: "sender_old" },
            },
            {
              id: "sms-1",
              type: "sms",
              zavu_sender_id: "sender_old",
              metadata: { routing: { sender_id: "sender_old" } },
            },
            {
              id: "sms-2",
              type: "sms",
              zavu_sender_id: "sender_other",
            },
          ],
        },
      },
      error: null,
    });

    await replaceChannelSenderReferences("site-1", "sender_old", "sender_new");

    const update = mockUpdate.mock.calls[0][0];
    expect(update.channels.connections).toEqual([
      expect.objectContaining({
        id: "voice-1",
        zavu_sender_id: "sender_new",
        metadata: expect.objectContaining({ sender_id: "sender_new" }),
      }),
      expect.objectContaining({
        id: "sms-1",
        zavu_sender_id: "sender_new",
        metadata: expect.objectContaining({
          routing: expect.objectContaining({ sender_id: "sender_new" }),
        }),
      }),
      {
        id: "sms-2",
        type: "sms",
        zavu_sender_id: "sender_other",
      },
    ]);
    expect(mockUpdateEq).toHaveBeenCalledWith("site_id", "site-1");
  });

  it("replaces sibling sender references in the same write that finalizes Voice", async () => {
    mockMaybeSingle.mockResolvedValue({
      data: {
        id: "settings-1",
        channels: {
          connections: [
            {
              id: "voice-1",
              type: "voice",
              status: "in_progress",
              zavu_sender_id: "sender_new",
              metadata: { previous_sender_id: "sender_old" },
            },
            {
              id: "sms-1",
              type: "sms",
              status: "connected",
              zavu_sender_id: "sender_old",
            },
          ],
        },
      },
      error: null,
    });

    const result = await upsertChannelConnection(
      "site-1",
      "voice-1",
      {
        status: "connected",
        metadata: { previous_sender_id: undefined },
      },
      {
        replaceSender: {
          previousSenderId: "sender_old",
          replacementSenderId: "sender_new",
        },
      }
    );

    const update = mockUpdate.mock.calls[0][0];
    expect(update.channels.connections).toEqual([
      expect.objectContaining({
        id: "voice-1",
        status: "connected",
        zavu_sender_id: "sender_new",
      }),
      expect.objectContaining({
        id: "sms-1",
        zavu_sender_id: "sender_new",
      }),
    ]);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(result.connections).toEqual(update.channels.connections);
  });
});
