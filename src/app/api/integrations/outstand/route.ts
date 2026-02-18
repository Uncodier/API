import { start } from "workflow/api";
import { handleOutstandIntegration } from "@/workflows/outstand";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const body = await request.json();

  // Executes asynchronously and doesn't block your app
  const { runId } = await start(handleOutstandIntegration, [body]);

  return NextResponse.json({
    message: "Outstand integration workflow started",
    runId,
  });
}
