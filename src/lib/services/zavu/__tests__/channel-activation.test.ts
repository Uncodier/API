import { ensureSenderChannelActive, ACTIVATABLE_CHANNELS, isChannelActivationBlocked } from "../channel-activation";
import { activateSenderChannel, zavuFetch } from "../client";

jest.mock("../client", () => ({ activateSenderChannel: jest.fn(), zavuFetch: jest.fn() }));

beforeEach(() => jest.resetAllMocks());

it.each(ACTIVATABLE_CHANNELS)("activates %s only after verifying the provider response", async (channel) => {
  (zavuFetch as jest.Mock).mockResolvedValue({ sender: { id: "sender/1", channels: [] } });
  const response = { activated: true, chargedCents: 100, sender: { id: "sender/1", channels: [channel] } };
  (activateSenderChannel as jest.Mock).mockResolvedValue(response);
  await expect(ensureSenderChannelActive("sender/1", channel)).resolves.toEqual(response);
  expect(zavuFetch).toHaveBeenCalledWith("/senders/sender%2F1");
  expect(activateSenderChannel).toHaveBeenCalledWith("sender/1", channel);
});

it.each(ACTIVATABLE_CHANNELS)("does not charge an already active %s channel", async (channel) => {
  (zavuFetch as jest.Mock).mockResolvedValue({ id: "sender", channels: [channel] });
  await expect(ensureSenderChannelActive("sender", channel)).resolves.toMatchObject({ activated: false, chargedCents: 0 });
  expect(activateSenderChannel).not.toHaveBeenCalled();
});

it.each([
  { activated: true },
  { sender: { id: "other", channels: ["whatsapp"] } },
  { sender: { id: "sender", channels: [] } },
])("rejects unconfirmed activation %j", async (response) => {
  (zavuFetch as jest.Mock).mockResolvedValue({ id: "sender", channels: [] });
  (activateSenderChannel as jest.Mock).mockResolvedValue(response);
  await expect(ensureSenderChannelActive("sender", "whatsapp")).rejects.toThrow("did not confirm");
});

it("fails closed on provider lookup failure or mismatched sender", async () => {
  (zavuFetch as jest.Mock).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ id: "other" });
  await expect(ensureSenderChannelActive("sender", "whatsapp")).rejects.toThrow("offline");
  await expect(ensureSenderChannelActive("sender", "whatsapp")).rejects.toThrow("different sender");
  expect(activateSenderChannel).not.toHaveBeenCalled();
});

it("reconciles an ambiguous activation on retry without another POST", async () => {
  (zavuFetch as jest.Mock).mockResolvedValueOnce({ id: "sender", channels: [] })
    .mockResolvedValueOnce({ id: "sender", channels: ["telegram"] });
  (activateSenderChannel as jest.Mock).mockRejectedValue(new Error("timeout"));
  await expect(ensureSenderChannelActive("sender", "telegram")).rejects.toThrow("timeout");
  await expect(ensureSenderChannelActive("sender", "telegram")).resolves.toMatchObject({ chargedCents: 0 });
  expect(activateSenderChannel).toHaveBeenCalledTimes(1);
});

it.each([{ enabled: false }, { license_suspended: true }, { _license: { manually_disabled: true } }, { status: "disabled" }])(
  "blocks inactive local connections %j", (connection) => expect(isChannelActivationBlocked(connection)).toBe(true),
);