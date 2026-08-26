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

export function generateAvailableSlots(
  date: string,
  startTimeStr: string,
  endTimeStr: string,
  duration: number,
  existingMeetings: any[],
  requestedParticipants: string[],
  requestedResources: string[],
  teamMembers: any[],
  timezone: string
): SchedulingSlot[] {
  const tz = normalizeTimezone(timezone);
  const startTime = localWallTimeToUtc(date, tz, toClockTime(startTimeStr));
  const endTime = localWallTimeToUtc(date, tz, toClockTime(endTimeStr));

  const slots: SchedulingSlot[] = [];
  let currentSlotStart = startTime;

  while (addMinutes(currentSlotStart, duration) <= endTime) {
    const slotEnd = addMinutes(currentSlotStart, duration);
    const { isAvailable, availableParticipants, availableResources } = checkSlotAvailability(
      currentSlotStart,
      slotEnd,
      existingMeetings,
      requestedParticipants,
      requestedResources,
      teamMembers
    );

    if (isAvailable || availableParticipants.length > 0) {
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

    currentSlotStart = addMinutes(currentSlotStart, 30);
  }

  return slots;
}

function checkSlotAvailability(
  slotStart: Date,
  slotEnd: Date,
  existingMeetings: any[],
  requestedParticipants: string[],
  requestedResources: string[],
  teamMembers: any[]
) {
  const availableParticipants = [...teamMembers];
  const availableResources = [...requestedResources];

  for (const meeting of existingMeetings) {
    const meetingStart = new Date(meeting.start_datetime);
    const meetingEnd = new Date(meeting.end_datetime);
    const overlaps = slotStart < meetingEnd && slotEnd > meetingStart;
    if (!overlaps) continue;

    const meetingParticipants = meeting.assignees || [];
    availableParticipants.forEach((participant, index) => {
      if (meetingParticipants.includes(participant.id)) {
        availableParticipants.splice(index, 1);
      }
    });

    const meetingResources = meeting.resources || [];
    meetingResources.forEach((resource: string) => {
      const index = availableResources.indexOf(resource);
      if (index !== -1) {
        availableResources.splice(index, 1);
      }
    });
  }

  const allParticipantsAvailable = requestedParticipants.every((p) =>
    availableParticipants.some((ap) => ap.id === p)
  );
  const allResourcesAvailable = requestedResources.every((r) => availableResources.includes(r));

  return {
    isAvailable: allParticipantsAvailable && allResourcesAvailable,
    availableParticipants,
    availableResources,
  };
}
