import { NextResponse } from 'next/server';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { waitForSubmittedCommand } from '@/lib/agentbase/services/command/waitForSubmittedCommand';
import { detectLanguageAndRegion, generateCulturalEmailPatterns, isExecutivePosition, extractDepartmentFromContext } from './command-helpers-1';
export function generateEmailPatterns(name: string, domain: string, context: string = ''): string[] {
    const cleanName = name.toLowerCase().trim();
    const nameParts = cleanName.split(' ').filter(part => part.length > 0);
    if (nameParts.length === 0) {
        return [];
    }
    const firstName = nameParts[0];
    const lastName = nameParts.length > 1 ? nameParts[nameParts.length - 1] : '';
    const middleName = nameParts.length > 2 ? nameParts[1] : '';
    const personalPatterns = [];
    const departmentalPatterns = [];
    const { language, region, cultural_patterns } = detectLanguageAndRegion(name, context);
    const departments = extractDepartmentFromContext(context);
    const culturalPatterns = generateCulturalEmailPatterns(name, domain, language, region, cultural_patterns);
    if (firstName && lastName) {
        if (culturalPatterns.length > 0) {
            personalPatterns.push(...culturalPatterns.slice(0, 3));
        }
        const universalPatterns = [];
        universalPatterns.push(`${firstName}.${lastName}@${domain}`);
        if (region === 'germany' || language === 'german') {
            universalPatterns.push(`${lastName}.${firstName}@${domain}`);
        }
        universalPatterns.push(`${firstName.charAt(0)}.${lastName}@${domain}`);
        universalPatterns.push(`${firstName.charAt(0)}${lastName}@${domain}`);
        universalPatterns.push(`${firstName}${lastName}@${domain}`);
        universalPatterns.push(`${firstName}_${lastName}@${domain}`);
        universalPatterns.push(`${firstName}@${domain}`);
        universalPatterns.push(`${firstName}.${lastName.charAt(0)}@${domain}`);
        if (region !== 'germany') {
            universalPatterns.push(`${lastName}.${firstName}@${domain}`);
        }
        universalPatterns.push(`${firstName}-${lastName}@${domain}`);
        if (middleName) {
            universalPatterns.push(`${firstName}.${middleName.charAt(0)}.${lastName}@${domain}`);
            universalPatterns.push(`${lastName}_${firstName}@${domain}`);
        }
        else {
            universalPatterns.push(`${lastName}_${firstName}@${domain}`);
            universalPatterns.push(`${firstName.charAt(0)}.${middleName ? middleName.charAt(0) + '.' : ''}${lastName.charAt(0)}@${domain}`);
        }
        for (const pattern of universalPatterns) {
            if (!personalPatterns.includes(pattern) && personalPatterns.length < 10) {
                personalPatterns.push(pattern);
            }
        }
        if (personalPatterns.length < 10 && culturalPatterns.length > 3) {
            for (const pattern of culturalPatterns.slice(3)) {
                if (!personalPatterns.includes(pattern) && personalPatterns.length < 10) {
                    personalPatterns.push(pattern);
                }
            }
        }
    }
    else if (firstName) {
        personalPatterns.push(`${firstName}@${domain}`);
        if (culturalPatterns.length > 0) {
            personalPatterns.push(...culturalPatterns.slice(0, 5));
        }
        for (let i = 1; personalPatterns.length < 10; i++) {
            const pattern = `${firstName}${i}@${domain}`;
            if (!personalPatterns.includes(pattern)) {
                personalPatterns.push(pattern);
            }
        }
    }
    if (departments.length > 0 && firstName) {
        const primaryDept = departments[0];
        if (lastName) {
            departmentalPatterns.push(`${firstName}.${lastName}@${primaryDept}.${domain}`);
            departmentalPatterns.push(`${primaryDept}.${firstName}@${domain}`);
            departmentalPatterns.push(`${firstName}@${primaryDept}.${domain}`);
            departmentalPatterns.push(`${primaryDept}.${lastName}@${domain}`);
            departmentalPatterns.push(`${firstName.charAt(0)}.${primaryDept}@${domain}`);
        }
        else {
            departmentalPatterns.push(`${firstName}@${primaryDept}.${domain}`);
            departmentalPatterns.push(`${primaryDept}.${firstName}@${domain}`);
            departmentalPatterns.push(`${primaryDept}@${domain}`);
            departmentalPatterns.push(`${firstName}.${primaryDept}@${domain}`);
            departmentalPatterns.push(`info.${primaryDept}@${domain}`);
        }
    }
    else {
        if (language === 'spanish' || region === 'hispanic') {
            departmentalPatterns.push(`info@${domain}`);
            departmentalPatterns.push(`contacto@${domain}`);
            departmentalPatterns.push(`ventas@${domain}`);
            departmentalPatterns.push(`hola@${domain}`);
            departmentalPatterns.push(`admin@${domain}`);
        }
        else {
            departmentalPatterns.push(`info@${domain}`);
            departmentalPatterns.push(`contact@${domain}`);
            departmentalPatterns.push(`admin@${domain}`);
            departmentalPatterns.push(`hello@${domain}`);
            departmentalPatterns.push(`sales@${domain}`);
        }
    }
    const allPatterns = [...personalPatterns.slice(0, 10), ...departmentalPatterns.slice(0, 5)];
    const seen = new Set<string>();
    const uniquePatterns = allPatterns.filter(pattern => {
        if (seen.has(pattern)) {
            return false;
        }
        seen.add(pattern);
        return true;
    });
    if (uniquePatterns.length < 15) {
        const additionalPatterns = [];
        if (firstName && lastName) {
            const extraVariations = [
                `${lastName}.${firstName}@${domain}`,
                `${firstName}${lastName.charAt(0)}@${domain}`,
                `${firstName.charAt(0)}${lastName.charAt(0)}@${domain}`,
                `${firstName}1@${domain}`,
                `${firstName}2@${domain}`,
                `${lastName}@${domain}`,
                `${firstName.charAt(0)}.${lastName.charAt(0)}@${domain}`,
                `${firstName}_${lastName.charAt(0)}@${domain}`,
                `${firstName}.${lastName}1@${domain}`,
                `${firstName}-${lastName.charAt(0)}@${domain}`
            ];
            for (const pattern of extraVariations) {
                if (!seen.has(pattern) && uniquePatterns.length < 15) {
                    uniquePatterns.push(pattern);
                    seen.add(pattern);
                }
            }
        }
        if (uniquePatterns.length < 15) {
            const moreGenericEmails = [
                `sales@${domain}`,
                `marketing@${domain}`,
                `office@${domain}`,
                `team@${domain}`,
                `general@${domain}`,
                `reception@${domain}`,
                `mail@${domain}`,
                `service@${domain}`,
                `business@${domain}`,
                `info@${domain}`
            ];
            for (const pattern of moreGenericEmails) {
                if (!seen.has(pattern) && uniquePatterns.length < 15) {
                    uniquePatterns.push(pattern);
                    seen.add(pattern);
                }
            }
        }
    }
    const isExecutive = isExecutivePosition(context);
    let finalPatterns = uniquePatterns.slice(0, 15);
    finalPatterns = filterSupportHelpAssistanceEmails(finalPatterns);
    if (isExecutive) {
        const executiveGenericEmails = [];
        const { language, region } = detectLanguageAndRegion(name, context);
        if (language === 'spanish' || region === 'hispanic') {
            const spanishExecutiveEmails = [
                `direccion@${domain}`,
                `gerencia@${domain}`,
                `presidencia@${domain}`,
                `ejecutivos@${domain}`,
                `administracion@${domain}`,
                `gestion@${domain}`,
                `corporativo@${domain}`,
                `directorio@${domain}`
            ];
            executiveGenericEmails.push(...spanishExecutiveEmails);
        }
        else {
            const englishExecutiveEmails = [
                `management@${domain}`,
                `executive@${domain}`,
                `leadership@${domain}`,
                `board@${domain}`,
                `corporate@${domain}`,
                `executives@${domain}`,
                `administration@${domain}`,
                `governance@${domain}`
            ];
            executiveGenericEmails.push(...englishExecutiveEmails);
        }
        const executiveSeen = new Set(finalPatterns);
        for (const email of executiveGenericEmails) {
            if (!executiveSeen.has(email) && finalPatterns.length < 20) {
                finalPatterns.push(email);
                executiveSeen.add(email);
            }
        }
        finalPatterns = filterSupportHelpAssistanceEmails(finalPatterns);
    }
    return finalPatterns;
}
export function validateEmailsNotUsingSiteDomain(emails: string[], siteDomain: string | null, leadDomain: string): {
    validEmails: string[];
    filteredCount: number;
    needsFallback: boolean;
} {
    if (!siteDomain) {
        return { validEmails: emails, filteredCount: 0, needsFallback: false };
    }
    const siteDomainClean = siteDomain.toLowerCase().trim();
    const leadDomainClean = leadDomain.toLowerCase().trim();
    const validEmails = emails.filter(email => {
        const emailLower = email.toLowerCase();
        const emailDomain = emailLower.split('@')[1];
        if (emailDomain === siteDomainClean || emailDomain.endsWith(`.${siteDomainClean}`)) {
            console.log(`🚫 Filtered generated email using site domain: ${email}`);
            return false;
        }
        if (emailDomain !== leadDomainClean && !emailDomain.endsWith(`.${leadDomainClean}`)) {
            console.log(`🚫 Filtered generated email not using lead domain: ${email}`);
            return false;
        }
        return true;
    });
    const needsFallback = validEmails.length === 0 && emails.length > 0;
    if (needsFallback) {
        console.log(`⚠️ All generated emails were filtered (using site domain). Will generate fallback emails for lead domain: ${leadDomain}`);
    }
    return {
        validEmails,
        filteredCount: emails.length - validEmails.length,
        needsFallback
    };
}
export function filterSupportHelpAssistanceEmails(emails: string[]): string[] {
    const blockedPrefixes = [
        'support', 'help', 'assistance', 'soporte', 'ayuda', 'asistencia',
        'support-team', 'helpdesk', 'help-desk', 'customer-support', 'customer-service',
        'soporte-tecnico', 'atencion-cliente', 'servicio-cliente'
    ];
    return emails.filter(email => {
        const emailLower = email.toLowerCase();
        const localPart = emailLower.split('@')[0];
        for (const prefix of blockedPrefixes) {
            if (localPart === prefix || localPart.startsWith(`${prefix}.`) || localPart.startsWith(`${prefix}-`)) {
                console.log(`🚫 Filtered support/help/assistance email: ${email}`);
                return false;
            }
        }
        return true;
    });
}
export const processorInitializer = ProcessorInitializer.getInstance();
processorInitializer.initialize();
export const commandService = processorInitializer.getCommandService();
