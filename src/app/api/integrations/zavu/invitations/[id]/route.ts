import { NextRequest, NextResponse } from "next/server";
import { cancelInvitation, getInvitation } from "@/lib/services/zavu/client";
import { findInvitationConnection, handleInvitationStatusChanged } from "@/lib/services/zavu/invitation-finalization";
import { requireZavuSiteManager } from "@/lib/services/zavu/site-access";

async function authorize(request: NextRequest, id: string) {
  const siteId = request.nextUrl.searchParams.get("siteId");
  if (!siteId || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw Object.assign(new Error("Invalid invitation request"), { status: 400 });
  }
  await requireZavuSiteManager(request, siteId);
  await findInvitationConnection(id, siteId);
  return siteId;
}

function failure(error: any) {
  const status = [400, 401, 403, 404, 409].includes(error?.status) ? error.status : 502;
  return NextResponse.json({ error: status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Invitation could not be finalized" }, { status });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const siteId = await authorize(request, id);
    const connection = await handleInvitationStatusChanged({ invitationId: id }, siteId);
    return NextResponse.json({ success: true, invitation: {
      id,
      status: connection.status === "connected" ? "completed" : connection.status,
      senderId: connection.zavu_sender_id,
      connectedAccount: connection.connected_account,
      activationPending: connection.metadata?.activation_pending === true,
      failureReason: connection.metadata?.failure_reason || undefined,
    } });
  } catch (error: any) {
    return failure(error);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await authorize(request, id);
    const invitation = await getInvitation(id);
    if (invitation.id !== id || invitation.status === "completed") {
      return NextResponse.json({ error: "Completed invitations cannot be cancelled" }, { status: 409 });
    }
    await cancelInvitation(id);
    return NextResponse.json({ success: true, message: "Invitation cancelled" });
  } catch (error: any) {
    return failure(error);
  }
}
