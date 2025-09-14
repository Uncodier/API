export function buildWrapUpContext(params: {
  siteId: string;
  systemMemories: any[];
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
  const { siteId, systemMemories, salesMemories, supportMemories, growthMemories, standupCommands, wrapUpInputs } = params;

  const lines = (s: string) => s;

  const systemSection = systemMemories.length > 0
    ? systemMemories.map((mem: any, index: number) => `${index + 1}. Memory ID: ${mem.id}\n   Command ID: ${mem.command_id}\n   Data: ${JSON.stringify(mem.data).substring(0, 300)}...`).join('\n')
    : 'No system analysis memories found';

  const salesSection = salesMemories.length > 0
    ? salesMemories.map((mem: any, index: number) => `${index + 1}. Memory ID: ${mem.id}\n   Command ID: ${mem.command_id}\n   Data: ${JSON.stringify(mem.data).substring(0, 300)}...`).join('\n')
    : 'No sales analysis memories found';

  const supportSection = supportMemories.length > 0
    ? supportMemories.map((mem: any, index: number) => `${index + 1}. Memory ID: ${mem.id}\n   Command ID: ${mem.command_id}\n   Data: ${JSON.stringify(mem.data).substring(0, 300)}...`).join('\n')
    : 'No support analysis memories found';

  const growthSection = growthMemories.length > 0
    ? growthMemories.map((mem: any, index: number) => `${index + 1}. Memory ID: ${mem.id}\n   Command ID: ${mem.command_id}\n   Data: ${JSON.stringify(mem.data).substring(0, 300)}...`).join('\n')
    : 'No growth analysis memories found';

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

  const context = lines(`Daily StandUp - Executive Summary & Wrap-Up for Site: ${siteId}

CONSOLIDATED ANALYSIS FROM ALL DEPARTMENTS:

=== SYSTEM ANALYSIS ===
${systemSection}

=== SALES ANALYSIS ===
${salesSection}

=== SUPPORT ANALYSIS ===
${supportSection}

=== GROWTH ANALYSIS ===
${growthSection}

RECENT STANDUP COMMANDS SUMMARY:
${commandsSection}

EXECUTIVE SUMMARY REQUIREMENTS:
Please consolidate all the departmental analyses into a comprehensive daily standup report focusing on:

1. **Overall Business Health**: Cross-departmental insights and systemic issues
2. **Key Performance Indicators**: Critical metrics from system, sales, support, and growth
3. **Resource Allocation**: Team capacity and workload distribution across departments
4. **Strategic Priorities**: Action items and recommendations for immediate attention
5. **Risk Assessment**: Potential issues and bottlenecks identified across departments
6. **Growth Opportunities**: Identified opportunities for optimization and expansion
7. **Next Steps**: Concrete action plan for the next 24 hours
8. **Key actions for the human team to take**: based on the analysis and recommendations of the rest te ai team, that would make the best results for the company

IMPORTANT:
- Consider the team size, of the company, the swot, focus in account setup or campaign requirments, things the user can accomplish thorugh the day.
- Avoid complex tasks, that would make the user to do a lot of work, and not be able to do it. (you can mention it, but not make it as a priority)
- Avoid referening as human, use the team member or role when required.
- The summary should be in the language of the company.
- Make list of priorities for the day.
- Be concise and to the point. Try to generate tasks, not general recommendations.
- Avoid obvious things like, attend clients, be consice in which client, what task, what content or campaign.
- Be short, if only one task may be acomplished, just mention that one task that could make the rest easier or more effective.

CLIENT ACTIVATION & INVITATION GUIDELINES:
- Use a helpful, proactive tone that nudges the client to take one concrete step in Uncodie today.
- Close with one clear invitation to use Uncodie (e.g., "Log in to your Uncodie dashboard to start today's priority" or "Enable your campaign in Uncodie now").
- Reference specific Uncodie actions relevant to the day: review new leads, connect inbox, approve a campaign, launch a template, adjust targeting, or check the pipeline.
- Keep the invitation plain text and compliant with output rules (no markdown, emojis, or links); make it achievable within 5 minutes.
- If priorities are very limited, offer one quick-win CTA that unlocks the next steps.

CRITICAL FORMAT RULES FOR OUTPUT (MUST FOLLOW):
- Output must be plain text only. Do not use markdown, HTML, emojis, or code fences.
- Use ASCII characters only. Avoid smart quotes and special symbols.
- Use simple dashes '-' for bullet points when needed.
- Provide a single line beginning with 'Status:' followed by one of GREEN, YELLOW, or RED and a short reason (e.g., "Status: YELLOW - billing pending and setup incomplete").
- Provide priorities as short bullets starting with '- ' under 140 characters each.
- Avoid headings with symbols (#, **, etc.). Use simple sentences.

${operationalInputs}

The summary should be executive-level, actionable, and provide clear visibility into the current state of operations across all business functions.`);
  
  const exampleReport = `Daily Executive Report - Marketing (2025-09-14)

One-line summary: we are pushing CPL < $10 and 5 ICP demos today; we have good lead volume, but Facebook shows fatigue and needs creative rotation.

Current status (last 24h):
- Leads: 28 | CPL: $11.40 (target <$10)
- Email CTR: 4.9%
- Demos scheduled: 3
- Pipeline created: $7,200 | New MRR: $0 (closings estimated Tuesday)

What worked yesterday:
- Launched 3 creative variations for the ROI Challenge (initial learnings to optimize hooks).
- Published founder video on LinkedIn + snippet on TikTok (good initial organic traction for awareness).
- Activated WhatsApp nurturing for cold leads (first positive replies).

Today’s priorities:
- Optimize the ad copy with the highest CPM (hypothesis: more direct hook + test benefit in the first line).
- Qualify 10 leads and hand off to sales (focused on ICP: SaaS 10-50 employees).
- Ship a mini ROI calculator landing with 1 CTA to demo to capture high intent.

Risks and mitigation:
- Fatigue on Facebook (+22% in CPL) -> rotate creatives today 18:00 and refresh test audiences.

Decisions required (by 12:00):
- Move +$20 budget to TikTok today vs keep on LinkedIn. Recommendation: controlled test on TikTok (small split) to read CPM/CPV and decide expansion tomorrow. If approved, activate at 14:00.

Dependencies:
- Design: 2 hero variants for the landing (ETA 16:00) for a quick A/B test.

Upcoming milestones:
- Draft agenda for partner webinar: tomorrow 10:00.

Market insight:
- Agencies request a 72h SLA for demos to proceed with white-label; this can be a differentiator if we formalize it in the commercial proposal.

Specific actions I need today:
- TikTok budget confirmation (deadline 12:00).
- Quick approval of the updated ad copy (I will share the final version at 13:30).`;

  return `${context}

EXAMPLE REPORT (FORMAT GUIDE):
${exampleReport}`;
}


