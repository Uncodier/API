import { z } from 'zod';
import { REPORT_SECTION_LABELS, type ReportSection } from './dailyStandupReportSections';

/** Do not fall back to generic summaries/health or unscoped text from the model. */
export function renderReportResults(results: unknown, selected: ReportSection[]) {
  if (!selected.length || !Array.isArray(results)) throw new Error('Invalid report results');
  const candidate = results.find(result => result && typeof result === 'object' && 'sections' in result);
  const shape = Object.fromEntries(selected.map(section => [section, z.string().trim().min(1).max(4000)]));
  const sections = z.object(shape).strict().parse(candidate?.sections);
  return {
    subject: 'Daily Standup',
    message: selected.map(section => `${REPORT_SECTION_LABELS[section]}\n${sections[section]}`).join('\n\n'),
    report_sections: selected,
  };
}