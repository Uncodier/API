import { patchActivationConnection, requireActivationLicense } from "../activation-persistence";
import { supabaseAdmin } from "@/lib/database/supabase-server";
import { getSiteLicensedResources } from "@/lib/billing/licensed-resources";

jest.mock("@/lib/database/supabase-server", () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock("@/lib/billing/licensed-resources", () => ({ getSiteLicensedResources: jest.fn(), isChannelActiveStatus: (_type: string, status: string) => status === "connected" }));
jest.mock("@/lib/services/site-configuration-cache", () => ({ refreshSiteConfigurationCaches: jest.fn() }));

let channels: any;
let onWrite: (() => void) | undefined;
let canonicalTransform: ((value: any) => any) | undefined;
let writes: number;
let billing: any;
const expected = { type: "whatsapp", senderId: "sender" };
beforeEach(() => {
  jest.resetAllMocks(); writes = 0; onWrite = undefined; canonicalTransform = undefined; billing = null;
  channels = { connections: [{ id: "channel", type: "whatsapp", status: "in_progress", zavu_sender_id: "sender", metadata: {} }] };
  (supabaseAdmin.from as jest.Mock).mockImplementation((table) => {
    let update: any; let snapshot: string;
    const query: any = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn((key, value) => { if (key === "channels") snapshot = value; return query; }),
      update: jest.fn((value) => { update = value; return query; }),
      maybeSingle: jest.fn(async () => {
        if (table === "billing") return { data: billing, error: null };
        if (!update) return { data: { channels: JSON.parse(JSON.stringify(channels)) }, error: null };
        writes++;
        onWrite?.();
        if (snapshot !== JSON.stringify(channels)) return { data: null, error: null };
        channels = canonicalTransform ? canonicalTransform(update.channels) : update.channels;
        return { data: { channels }, error: null };
      }),
    };
    return query;
  });
});

it("preserves unrelated metadata and returns canonical persisted status", async () => {
  channels.connections[0].metadata.secret = "encrypted";
  const result = await patchActivationConnection("site", "channel", { status: "connected", metadata: { activation_pending: false } }, expected);
  expect(result).toMatchObject({ status: "connected", metadata: { secret: "encrypted", activation_pending: false } });
});
it.each(["disabled", "deleted", "sender-changed"])("does not overwrite concurrent %s", async (change) => {
  onWrite = () => {
    onWrite = undefined;
    if (change === "deleted") channels.connections = [];
    else if (change === "disabled") channels.connections[0].enabled = false;
    else channels.connections[0].zavu_sender_id = "different";
  };
  await expect(patchActivationConnection("site", "channel", { status: "connected" }, expected)).rejects.toMatchObject({ status: 409 });
  expect(writes).toBe(1);
});
it("retries unrelated concurrent changes without losing them", async () => {
  onWrite = () => { onWrite = undefined; channels.anotherSetting = true; };
  await patchActivationConnection("site", "channel", { status: "connected" }, expected);
  expect(channels.anotherSetting).toBe(true);
  expect(writes).toBe(2);
});
it("does not report connected when a license trigger suspends the saved row", async () => {
  canonicalTransform = (value) => ({ ...value, connections: value.connections.map((c: any) => ({ ...c, status: "disabled", license_suspended: true })) });
  await expect(patchActivationConnection("site", "channel", { status: "connected" }, expected)).rejects.toMatchObject({ status: 409 });
});
it("bounds conflict retries", async () => {
  onWrite = () => { channels.version = (channels.version || 0) + 1; };
  await expect(patchActivationConnection("site", "channel", { status: "connected" }, expected)).rejects.toMatchObject({ status: 409 });
  expect(writes).toBe(3);
});
it("replaces an invitation using the old ID precondition and verifies the new canonical ID", async () => {
  channels.connections[0].zavu_invitation_id = "old";
  await expect(patchActivationConnection("site", "channel", { zavu_invitation_id: "new" }, { ...expected, invitationId: "old" }))
    .resolves.toMatchObject({ zavu_invitation_id: "new" });
});
it("allows pending licensed setup but rejects projected suspension and outage", async () => {
  (getSiteLicensedResources as jest.Mock).mockResolvedValue({ effective_plan: "engine", social_media: [], channels: { connections: [{ ...channels.connections[0], license_suspended: false }] } });
  await expect(requireActivationLicense("site", "channel", expected)).resolves.toMatchObject({ status: "in_progress" });
  (getSiteLicensedResources as jest.Mock).mockResolvedValue({ channels: { connections: [{ ...channels.connections[0], license_suspended: true }] } });
  await expect(requireActivationLicense("site", "channel", expected)).rejects.toMatchObject({ status: 409 });
  (getSiteLicensedResources as jest.Mock).mockRejectedValue(new Error("unavailable"));
  await expect(requireActivationLicense("site", "channel", expected)).rejects.toThrow("unavailable");
});

it("denies activation at full capacity before incurring provider fees", async () => {
  (getSiteLicensedResources as jest.Mock).mockResolvedValue({ effective_plan: "engine", social_media: [], channels: { connections: [
    { ...channels.connections[0], license_suspended: false },
    { id: "occupied", type: "whatsapp", status: "connected", license_suspended: false },
  ] } });
  await expect(requireActivationLicense("site", "channel", expected)).rejects.toMatchObject({ code: "ACCOUNT_LIMIT" });
  billing = { addons_count: 1, stripe_subscription_id: null };
  await expect(requireActivationLicense("site", "channel", expected)).resolves.toBeDefined();
  billing = { addons_count: 100, stripe_subscription_id: "unpaid-subscription" };
  await expect(requireActivationLicense("site", "channel", expected)).rejects.toMatchObject({ code: "ACCOUNT_LIMIT" });
});

it("counts social overage against shared add-ons and denies commission without capacity", async () => {
  const projection = { effective_plan: "commission", social_media: [], channels: { connections: [{ ...channels.connections[0], license_suspended: false }] } };
  (getSiteLicensedResources as jest.Mock).mockResolvedValue(projection);
  await expect(requireActivationLicense("site", "channel", expected)).rejects.toMatchObject({ code: "ACCOUNT_LIMIT" });
  billing = { addons_count: 1, stripe_subscription_id: null };
  await expect(requireActivationLicense("site", "channel", expected)).resolves.toBeDefined();
  (getSiteLicensedResources as jest.Mock).mockResolvedValue({ ...projection, social_media: [
    { isActive: true, license_suspended: false }, { isActive: true, license_suspended: false },
  ] });
  await expect(requireActivationLicense("site", "channel", expected)).rejects.toMatchObject({ code: "ACCOUNT_LIMIT" });
});