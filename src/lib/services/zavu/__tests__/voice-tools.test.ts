jest.mock("../agent-client", () => ({
  listAgentTools: jest.fn(),
  upsertAgentTool: jest.fn(),
  deleteAgentTool: jest.fn(),
}));

import {
  deleteAgentTool,
  listAgentTools,
  upsertAgentTool,
} from "../agent-client";
import { syncVoiceTools } from "../voice-tools";

const mockListAgentTools = listAgentTools as jest.Mock;
const mockUpsertAgentTool = upsertAgentTool as jest.Mock;
const mockDeleteAgentTool = deleteAgentTool as jest.Mock;

describe("syncVoiceTools", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      API_SERVER_URL: "https://backend.makinari.com",
    };
    mockListAgentTools.mockResolvedValue([
      { id: "tool_old", name: "order_status" },
      { id: "tool_keep", name: "custom_tool" },
    ]);
    mockDeleteAgentTool.mockResolvedValue(undefined);
    mockUpsertAgentTool.mockResolvedValue({ id: "tool_capture" });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("removes retired mock tools and upserts capture_lead", async () => {
    await syncVoiceTools({
      agentId: "agent_1",
      siteId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      webhookSecret: "whsec_test",
    });

    expect(mockDeleteAgentTool).toHaveBeenCalledWith("agent_1", "tool_old");
    expect(mockDeleteAgentTool).not.toHaveBeenCalledWith("agent_1", "tool_keep");
    expect(mockUpsertAgentTool).toHaveBeenCalledWith(
      "agent_1",
      expect.objectContaining({
        name: "capture_lead",
        webhookUrl: expect.stringContaining("siteId=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"),
        webhookSecret: "whsec_test",
      })
    );
  });
});
