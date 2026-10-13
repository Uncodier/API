import { addMinutes } from 'date-fns';
import { formatInTimezone, localWallTimeToUtc, normalizeTimezone } from '@/lib/timezone';

function toClockTime(hhmm: string): string {
  const [hours = '00', minutes = '00'] = hhmm.split(':');
  return `${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}:00`;
}

export type SchedulingSlot = {
  start: string;
  end: string;
  start_utc: string;
  end_utc: string;
  timezone: string;
  available_participants: any[];
  available_resources: string[];
  all_participants_available: boolean;
};

export type SchedulingWindow = { start: number; end: number };
export type SchedulingSlotOptions = {
  now?: Date;
  memberWindows?: Map<string, SchedulingWindow[]>;
  bufferMinutes?: number;
  blocks?: Array<{ entity_type: string; entity_id: string | null; start_time: string; end_time: string }>;
};

export function generateAvailableSlots(
  date: string,
  startTimeStr: string,
  endTimeStr: string,
  duration: number,
  existingMeetings: any[],
  requestedParticipants: string[],
  requestedResources: string[],
  teamMembers: any[],
  timezone: string,
  options: SchedulingSlotOptions = {}
): SchedulingSlot[] {
  if (!Number.isInteger(duration) || duration < 1 || duration > 1440) return [];
  const tz = normalizeTimezone(timezone);
  const startTime = localWallTimeToUtc(date, tz, toClockTime(startTimeStr));
  const endTime = localWallTimeToUtc(date, tz, toClockTime(endTimeStr));

  const slots: SchedulingSlot[] = [];
  const candidateStarts = new Set<number>();
  const windows = options.memberWindows
    ? [...options.memberWindows.values()].flat()
    : [{ start: startTime.getTime(), end: endTime.getTime() }];
  for (const window of windows) {
    const lastEnd = Math.min(window.end, endTime.getTime());
    for (let start = Math.max(window.start, startTime.getTime()); start + duration * 60_000 <= lastEnd; start += 30 * 60_000) {
      candidateStarts.add(start);
    }
  }
  for (const candidate of [...candidateStarts].sort((a, b) => a - b)) {
    const currentSlotStart = new Date(candidate);
    const slotEnd = addMinutes(currentSlotStart, duration);
    const { isAvailable, availableParticipants, availableResources } = checkSlotAvailability(
      currentSlotStart,
      slotEnd,
      existingMeetings,
      requestedParticipants,
      requestedResources,
      teamMembers,
      options
    );

    if (isAvailable && (!options.now || currentSlotStart > options.now)) {
      slots.push({
        start: formatInTimezone(currentSlotStart, tz, 'HH:mm'),
        end: formatInTimezone(slotEnd, tz, 'HH:mm'),
        start_utc: currentSlotStart.toISOString(),
        end_utc: slotEnd.toISOString(),
        timezone: tz,
        available_participants: availableParticipants,
        available_resources: availableResources,
        all_participants_available: isAvailable,
      });
    }
  }

  return slots;
}

function checkSlotAvailability(
  slotStart: Date,
  slotEnd: Date,
  existingMeetings: any[],
  requestedParticipants: string[],
  requestedResources: string[],
  teamMembers: any[],
  options: SchedulingSlotOptions
) {
  const buffer = Math.max(0, options.bufferMinutes || 0) * 60_000;
  const start = slotStart.getTime();
  const end = slotEnd.getTime();
  const overlappingMeetings = existingMeetings.filter(meeting =>
    start < Date.parse(meeting.end_datetime) + buffer && end > Date.parse(meeting.start_datetime) - buffer
  );
  const availableParticipants = teamMembers.filter(member => {
    if (options.memberWindows && !(options.memberWindows.get(member.id) || []).some(window =>
      start >= window.start && end <= window.end
    )) return false;
    if ((options.blocks || []).some(block =>
      (block.entity_type === 'global' || (block.entity_type === 'user' && block.entity_id === member.id))
      && start < Date.parse(block.end_time) && end > Date.parse(block.start_time)
    )) return false;
    return !overlappingMeetings.some(meeting => {
      const participants = meeting.participants ?? meeting.assignees ?? [];
      // Legacy appointments without an assignee reserve site capacity conservatively.
      return !participants.length || participants.some((participant: unknown) => typeof participant === 'string' && (
        participant === member.id || (member.email && participant.trim().toLowerCase() === member.email.trim().toLowerCase())
      ));
    });
  });
  const availableResources = requestedResources.filter(resource =>
    !overlappingMeetings.some(meeting => (meeting.resources || []).includes(resource))
  );

  const allParticipantsAvailable = requestedParticipants.every((p) =>
    availableParticipants.some((ap) => ap.id === p)
  );
  const allResourcesAvailable = requestedResources.every((r) => availableResources.includes(r));

  return {
    isAvailable: availableParticipants.length > 0 && allParticipantsAvailable && allResourcesAvailable,
    availableParticipants,
    availableResources,
  };
}
