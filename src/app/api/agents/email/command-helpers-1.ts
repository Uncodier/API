import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { EmailService } from '@/lib/services/email/EmailService';
import { EmailSyncErrorService } from '@/lib/services/email/EmailSyncErrorService';
import { EmailConfigService } from '@/lib/services/email/EmailConfigService';
import { ComprehensiveEmailFilterService } from '@/lib/services/email/ComprehensiveEmailFilterService';
import { EmailProcessingService } from '@/lib/services/email/EmailProcessingService';
import { CommandManagementService } from '@/lib/services/email/CommandManagementService';
import { ValidationService } from '@/lib/services/email/ValidationService';
import { CaseConverterService, getFlexibleProperty } from '@/lib/utils/case-converter';

export const maxDuration = 300;
export const EmailAgentRequestSchema = z.object({
    site_id: z.string().min(1, "Site ID is required"),
    limit: z.number().max(100).default(5).optional(),
    lead_id: z.string().optional(),
    agentId: z.string().optional(),
    user_id: z.string().optional(),
    team_member_id: z.string().optional(),
    analysis_type: z.string().optional(),
    since_date: z.string().optional().refine((date) => !date || !isNaN(Date.parse(date)), "since_date debe ser una fecha válida en formato ISO"),
});
export const ERROR_CODES = {
    INVALID_REQUEST: 'INVALID_REQUEST',
    EMAIL_CONFIG_NOT_FOUND: 'EMAIL_CONFIG_NOT_FOUND',
    EMAIL_FETCH_ERROR: 'EMAIL_FETCH_ERROR',
    SYSTEM_ERROR: 'SYSTEM_ERROR',
    AGENT_NOT_FOUND: 'AGENT_NOT_FOUND'
};
export function isValidUUID(uuid: string): boolean {
    return ValidationService.isValidUUID(uuid);
}
export async function comprehensiveEmailFilter(emails: any[], siteId: string, emailConfig: any) {
    return await ComprehensiveEmailFilterService.comprehensiveEmailFilter(emails, siteId, emailConfig);
}
export async function findSupportAgent(siteId: string): Promise<string> {
    return await EmailProcessingService.findSupportAgent(siteId);
}
export async function getCommandDbUuid(internalId: string): Promise<string | null> {
    return await CommandManagementService.getCommandDbUuid(internalId);
}
export async function waitForCommandCompletion(commandId: string, maxAttempts = 200, delayMs = 1000) {
    return await CommandManagementService.waitForCommandCompletion(commandId, maxAttempts, delayMs);
}
export function createEmailCommand(agentId: string, siteId: string, emails: any[], emailConfig: any, analysisType?: string, leadId?: string, teamMemberId?: string, userId?: string) {
    return CommandManagementService.createEmailCommand(agentId, siteId, emails, emailConfig, analysisType, leadId, teamMemberId, userId);
}
export function isValidEmail(email: string): boolean {
    return ValidationService.isValidEmail(email);
}
