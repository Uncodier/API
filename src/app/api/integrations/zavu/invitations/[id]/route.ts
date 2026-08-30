import { NextRequest, NextResponse } from "next/server";
import { cancelInvitation, getInvitation } from "@/lib/services/zavu";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: "Invitation ID is required" }, { status: 400 });
    }

    const invitation = await getInvitation(id);
    return NextResponse.json({ success: true, invitation });
  } catch (error: any) {
    console.error("[Zavu] Error fetching invitation:", error);
    return NextResponse.json(
      { error: error.message || "Failed to retrieve invitation" },
      { status: error.status || 500 }
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: "Invitation ID is required" }, { status: 400 });
    }

    await cancelInvitation(id);
    return NextResponse.json({ success: true, message: "Invitation cancelled" });
  } catch (error: any) {
    console.error("[Zavu] Error cancelling invitation:", error);
    return NextResponse.json(
      { error: error.message || "Failed to cancel invitation" },
      { status: error.status || 500 }
    );
  }
}
