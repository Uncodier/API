import { supabaseAdmin } from "@/lib/database/supabase-server";

type PhoneResource = {
  id?: string;
  phoneNumber?: string;
  senderId?: string;
};

type PhoneAssignment = PhoneResource & {
  siteId: string;
};

const ASSIGNED_STATUSES = new Set([
  "active",
  "connected",
  "in_progress",
  "synced",
]);

function parseConnections(channels: unknown): any[] {
  let parsed = channels;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  if (!parsed || typeof parsed !== "object") return [];
  const connections = (parsed as { connections?: unknown }).connections;
  return Array.isArray(connections) ? connections : [];
}

async function loadPhoneAssignments(): Promise<PhoneAssignment[]> {
  const { data, error } = await supabaseAdmin
    .from("settings")
    .select("site_id, channels");
  if (error) throw new Error("Failed to verify phone-number ownership");

  return (data || []).flatMap((row: any) =>
    parseConnections(row.channels)
      .filter((connection) => ASSIGNED_STATUSES.has(connection.status))
      .map((connection) => ({
        siteId: row.site_id,
        id:
          connection.metadata?.phone_number_id ||
          connection.metadata?.routing?.phone_number_id,
        phoneNumber:
          connection.metadata?.phone_number ||
          connection.metadata?.routing?.phone_number ||
          connection.connected_account?.phoneNumber,
        senderId:
          connection.zavu_sender_id ||
          connection.metadata?.sender_id ||
          connection.metadata?.routing?.sender_id,
      }))
  );
}

function matchesResource(assignment: PhoneAssignment, resource: PhoneResource): boolean {
  return Boolean(
    (resource.id && assignment.id === resource.id) ||
      (resource.phoneNumber && assignment.phoneNumber === resource.phoneNumber) ||
      (resource.senderId && assignment.senderId === resource.senderId)
  );
}

export async function assertPhoneResourcesAvailable(
  siteId: string,
  resource: PhoneResource
): Promise<void> {
  const assignments = await loadPhoneAssignments();
  if (
    assignments.some(
      (assignment) =>
        assignment.siteId !== siteId && matchesResource(assignment, resource)
    )
  ) {
    const error = new Error("Phone resource is assigned to another site");
    (error as Error & { status?: number }).status = 403;
    throw error;
  }
}

export async function filterPhoneNumbersForSite<T extends PhoneResource>(
  siteId: string,
  phoneNumbers: T[]
): Promise<T[]> {
  const assignments = await loadPhoneAssignments();
  return phoneNumbers.filter(
    (phoneNumber) =>
      !assignments.some(
        (assignment) =>
          assignment.siteId !== siteId &&
          matchesResource(assignment, phoneNumber)
      )
  );
}
