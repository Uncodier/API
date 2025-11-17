export function buildWrapUpContext(params: {
  siteId: string;
  systemMemories: any[];
  systemNotifications?: any[];
  salesMemories: any[];
  supportMemories: any[];
  growthMemories: any[];
  standupCommands: any[];
  wrapUpInputs: {
    settings: any | null;
    prevDayRange: { start: string; end: string };
    prevDay: { leads: any[]; conversations: any[]; tasks: any[] };
    pendingContents: any[];
    counts: { leads: number; conversations: number; tasks: number; pendingContents: number };
  };
}) {
  const {
    siteId,
    systemMemories,
    systemNotifications = [],
    salesMemories,
    supportMemories,
    growthMemories,
    standupCommands,
    wrapUpInputs
  } = params;

  const lines = (s: string) => s;

  const systemSection = systemMemories.length > 0
    ? `=== SYSTEM ANALYSIS ===\n${systemMemories.map((mem: any, index: number) => `${index + 1}. Memory ID: ${mem.id}\n   Command ID: ${mem.command_id}\n   Data: ${JSON.stringify(mem.data).substring(0, 300)}...`).join('\n')}`
    : '';

  const salesSection = salesMemories.length > 0
    ? `=== SALES ANALYSIS ===\n${salesMemories.map((mem: any, index: number) => `${index + 1}. Memory ID: ${mem.id}\n   Command ID: ${mem.command_id}\n   Data: ${JSON.stringify(mem.data).substring(0, 300)}...`).join('\n')}`
    : '';

  const supportSection = supportMemories.length > 0
    ? `=== SUPPORT ANALYSIS ===\n${supportMemories.map((mem: any, index: number) => `${index + 1}. Memory ID: ${mem.id}\n   Command ID: ${mem.command_id}\n   Data: ${JSON.stringify(mem.data).substring(0, 300)}...`).join('\n')}`
    : '';

  const growthSection = growthMemories.length > 0
    ? `=== GROWTH ANALYSIS ===\n${growthMemories.map((mem: any, index: number) => `${index + 1}. Memory ID: ${mem.id}\n   Command ID: ${mem.command_id}\n   Data: ${JSON.stringify(mem.data).substring(0, 300)}...`).join('\n')}`
    : '';

  const systemNotificationSection = systemNotifications.length > 0
    ? `=== SYSTEM ANNOUNCEMENTS & IMPROVEMENTS (context only) ===
${systemNotifications.map((mem: any, index: number) => {
        const title = mem?.data?.title || mem?.key || `Notification ${index + 1}`;
        const summary = typeof mem?.data?.summary === 'string'
          ? mem.data.summary
          : JSON.stringify(mem?.data ?? {});
        const actionHint = mem?.data?.action || mem?.data?.cta || '';
        const rawData = JSON.stringify(mem ?? {}, null, 2);
        return `${index + 1}. ${title}
   Created: ${mem?.created_at || mem?.createdAt || 'Unknown'}
   Summary: ${summary}
   Raw Data: ${rawData}${actionHint ? `\n   Suggested Action: ${actionHint}` : ''}`;
      }).join('\n')}`
    : '';

  const consolidatedSections = [systemSection, salesSection, supportSection, growthSection, systemNotificationSection].filter(Boolean).join('\n\n');

  const commandsSection = (standupCommands || []).slice(0, 10).map((cmd: any, index: number) => `${index + 1}. ${cmd.task} - Status: ${cmd.status} - Created: ${cmd.created_at}`).join('\n');

  const settingsPresent = wrapUpInputs.settings ? 'Yes' : 'No';
  const leadsLines = (wrapUpInputs.prevDay.leads || []).slice(0, 10).map((l: any, i: number) => `${i + 1}. ${l.name || 'Unknown'} (${l.email || 'No email'}) - ${l.status || 'New'} - ${l.id || ''}`);
  const convLines = (wrapUpInputs.prevDay.conversations || []).slice(0, 5).map((c: any, i: number) => `${i + 1}. Conversation ${c.id} - Messages: ${Array.isArray(c.messages) ? c.messages.length : 0} - Created: ${c.created_at}`);
  const pendingContentLines = (wrapUpInputs.pendingContents || []).slice(0, 10).map((c: any, i: number) => `${i + 1}. ${c.title || 'Untitled'} - Type: ${c.type || 'Unknown'} - Status: ${c.status || 'Unknown'}`);
  const tasksLines = (wrapUpInputs.prevDay.tasks || []).slice(0, 10).map((t: any, i: number) => `${i + 1}. ${t.title || 'Untitled'} - Priority: ${t.priority || 'Normal'} - Status: ${t.status}`);

  const operationalInputs = lines(`
OPERATIONAL INPUTS FOR WRAP-UP (Previous Day UTC: ${wrapUpInputs.prevDayRange.start} to ${wrapUpInputs.prevDayRange.end})
- Settings present: ${settingsPresent}
- New Leads: ${wrapUpInputs.counts.leads}
- New Conversations: ${wrapUpInputs.counts.conversations}
- New Tasks: ${wrapUpInputs.counts.tasks}
- Pending Contents: ${wrapUpInputs.counts.pendingContents}

New Leads (up to 10):
${leadsLines.join('\n')}

New Conversations (up to 5):
${convLines.join('\n')}

Pending Contents (up to 10):
${pendingContentLines.join('\n')}

New Tasks (up to 10):
${tasksLines.join('\n')}
`);

  const context = lines(`Weekly StandUp - Kickoff & Wrap-Up for Site: ${siteId}

CONSOLIDATED ANALYSIS FROM ALL DEPARTMENTS:
${consolidatedSections}

RECENT STANDUP COMMANDS SUMMARY:
${commandsSection}

EXECUTIVE SUMMARY REQUIREMENTS:
Please consolidate all departmental analyses into a weekly standup report that clearly states whether you are opening the week (Monday kickoff) or closing it (Friday wrap). Always cover:

1. **Overall Business Health**: Cross-departmental insights and systemic issues for the entire Monday-Sunday window
2. **Key Performance Indicators**: Weekly metrics from system, sales, support, and growth tied to paid media and lifecycle performance
3. **Resource Allocation**: Capacity and ownership signals that affect the remaining days of the current week
4. **Strategic Priorities**: Start-of-week launch items or end-of-week closure tasks that unblock pipeline goals across marketing and revenue
5. **Risk Assessment**: Issues that could derail the week if not solved by midweek (kickoff) or before the weekend (wrap)
6. **Growth Opportunities**: Weekly experiments, automations, or channel expansions that should open Monday or conclude Friday
7. **Next Steps**: Concrete plan for the rest of the week (kickoff) or a Monday-ready handoff (wrap)
8. **Key actions for the team**: Tie each action to the kickoff or wrap context explicitly
9. **System Announcements & Improvements**: Call out platform changes, product updates, or automation improvements and explain the operational impact

WEEKLY RITUAL CADENCE:
- Monday standups initiate the week: lock Week N goals, confirm campaign calendars, and clear blockers by Wednesday.
- Friday standups close the loop: report wins, document learnings, and prep weekend automations or Monday jumpstart.
- If no day is specified, assume kickoff when today <= Wednesday and wrap when today >= Thursday.

IMPORTANT:
- Always anchor recommendations to the weekly window and specify if each action fuels the kickoff (start of week) or ensures the wrap (end of week).
- Consider team size, SWOT, account setup, channel requirements, and what can realistically be achieved within the remaining days.
- Avoid prioritizing complex, multi-day projects during the wrap unless they directly unblock Monday.
- Avoid referencing "human"; use the role or team member when required.
- The summary should be in the language of the company.
- Make a priorities list tied to kickoff acceleration or wrap closure.
- Be concise and task-driven. Mention channels, clients, content, or automation flows explicitly.
- Avoid obvious statements; specify the concrete deliverable.
- Keep it short; if one action unlocks the week, highlight only that.
- System announcements must appear inside Highlights, Risks, or Next Actions with their weekly impact clearly stated.

CLIENT ACTIVATION & INVITATION GUIDELINES:
- Use a helpful, proactive tone nudging the client to take one kickoff or wrap step inside Uncodie.
- Close with one clear invitation aligned to the kickoff or wrap context.
- Reference Uncodie actions that match the moment, emphasizing tasks achievable within the same session.
- Keep the invitation plain text (no markdown, emojis, or links) and under 5 minutes of effort.
- If priorities are limited, offer a single quick-win CTA that unlocks Monday readiness or Friday closure.

CRITICAL FORMAT RULES FOR OUTPUT (MUST FOLLOW):
- Output must be plain text only. Do not use markdown, HTML, emojis, or code fences.
- Use ASCII characters only. Avoid smart quotes and special symbols.
- Use simple dashes '-' for bullet points when needed.
- Do NOT include a 'Status:' line in the message. Status must live ONLY in the 'health' object (status, reason, priorities).
- Start the message with the single most useful kickoff or wrap action.
- Provide priorities as short bullets starting with '- ' under 140 characters each.
- Avoid headings with symbols (#, **, etc.). Use simple sentences.

TITLE REQUIREMENTS (CRITICAL):
- The title/subject MUST always be a kickoff or wrap CTA for the team.
- Use action verbs that direct the team to take start-of-week or end-of-week action.
- Avoid passive or descriptive titles like "Weekly Report" or "Status Update".
- Make the title actionable and time-sensitive when possible.
- Keep under 60 characters for email subject line compatibility.

${operationalInputs}

The summary should be executive-level, actionable, and provide clear visibility into the current state of operations across all business functions.`);
  
  return `${context}`;
}


