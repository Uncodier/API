import { sleep } from "workflow";
import { getOutstandClient } from "@/lib/integrations/outstand/client";
import { CreatePostParams } from "@/lib/integrations/outstand/types";

export async function handleOutstandIntegration(data: { action: string, payload: any }) {
  "use workflow";
  
  const { action, payload } = data;
  console.log(`Starting Outstand integration workflow for action: ${action}`, payload);

  let result;

  switch (action) {
    case 'create_post':
      result = await createPostStep(payload);
      break;
    case 'analyze_post':
      result = await analyzePostStep(payload.postId);
      break;
    default:
      throw new Error(`Unknown action: ${action}`);
  }
  
  console.log("Outstand integration workflow complete", result);

  return { status: "completed", result };
}

async function createPostStep(payload: CreatePostParams) {
  "use step";
  
  console.log("Creating post on Outstand", payload);
  const client = getOutstandClient();
  const result = await client.createPost(payload);
  
  return result;
}

async function analyzePostStep(postId: string) {
  "use step";
  
  console.log(`Analyzing post ${postId}`);
  const client = getOutstandClient();
  
  // Get details
  const details = await client.getPost(postId);
  
  // Get analytics
  const analytics = await client.getPostAnalytics(postId);
  
  return { details, analytics };
}
