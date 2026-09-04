import { NextRequest, NextResponse } from "next/server";
import { deleteSender, detachSenderFromAgent } from "@/lib/services/zavu";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: "Sender ID is required" }, { status: 400 });
    }

    await detachSenderFromAgent(id);
    await deleteSender(id);
    return NextResponse.json({ success: true, message: "Sender deleted" });
  } catch (error: any) {
    console.error("[Zavu] Error deleting sender:", error);
    return NextResponse.json(
      { error: error.message || "Failed to delete sender" },
      { status: error.status || 500 }
    );
  }
}
