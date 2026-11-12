import { NextResponse } from 'next/server';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { getCommandById as dbGetCommandById } from '@/lib/database/command-db';
import { DatabaseAdapter } from '@/lib/agentbase/adapters/DatabaseAdapter';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { isValidUUID, getSegmentInfo } from './command-helpers-1';
export async function getCampaignInfo(campaignId: string): Promise<any | null> {
    try {
        if (!isValidUUID(campaignId)) {
            console.log(`Invalid campaign ID: ${campaignId}`);
            return null;
        }
        const { data, error } = await supabaseAdmin
            .from('campaigns')
            .select('*')
            .eq('id', campaignId)
            .single();
        if (error) {
            console.error(`Error fetching campaign info: ${error.message}`);
            return null;
        }
        return data;
    }
    catch (error) {
        console.error('Error getting campaign info:', error);
        return null;
    }
}
export async function getSiteInfo(siteId: string): Promise<any | null> {
    try {
        if (!isValidUUID(siteId)) {
            console.log(`Invalid site ID: ${siteId}`);
            return null;
        }
        const { data, error } = await supabaseAdmin
            .from('sites')
            .select('*')
            .eq('id', siteId)
            .single();
        if (error) {
            console.error(`Error fetching site info: ${error.message}`);
            return null;
        }
        return data;
    }
    catch (error) {
        console.error('Error getting site info:', error);
        return null;
    }
}
export async function buildContext(siteId: string, draftContent: any[], segmentId?: string, campaignId?: string): Promise<string> {
    let contextParts = [];
    if (draftContent && draftContent.length > 0) {
        contextParts.push(`DRAFT CONTENT TO IMPROVE (${draftContent.length} items):
${draftContent.map((content, index) => `
${index + 1}. ID: ${content.id}
   - Title: ${content.title || 'No title'}
   - Description: ${content.description || 'No description'}
   - Content Type: ${content.type || 'Unknown'}
   - Created: ${content.created_at || 'Unknown'}
   - Content Length: ${content.text ? content.text.length : 0} characters
   - Preview: ${content.text ? content.text.substring(0, 150) + '...' : 'No content'}
`).join('')}

BULK IMPROVEMENT TASK:
Improve ALL the above content items simultaneously, maintaining consistency in style and quality across all pieces while optimizing each one individually for its specific purpose and context.`);
    }
    const siteInfo = await getSiteInfo(siteId);
    if (siteInfo) {
        const siteData = {
            name: siteInfo.name || 'Unnamed Site',
            description: siteInfo.description || 'No description available',
            domain: siteInfo.domain || 'N/A',
            primary_industry: siteInfo.industry || siteInfo.primary_industry || 'N/A',
            language: siteInfo.language || 'en',
            created_at: siteInfo.created_at || 'N/A'
        };
        contextParts.push(`SITE INFORMATION:
- Name: ${siteData.name}
- Description: ${siteData.description}
- Domain: ${siteData.domain}
- Industry: ${siteData.primary_industry}
- Language: ${siteData.language}
- Created: ${siteData.created_at}

${siteInfo.business_description ? `Business Description: ${siteInfo.business_description}` : ''}
${siteInfo.audience_description ? `Target Audience: ${siteInfo.audience_description}` : ''}
${siteInfo.challenges ? `Main Challenges: ${siteInfo.challenges}` : ''}
${siteInfo.competitors ? `Competitors: ${siteInfo.competitors}` : ''}
${siteInfo.unique_selling_proposition ? `Unique Selling Proposition: ${siteInfo.unique_selling_proposition}` : ''}
${siteInfo.brand_voice ? `Brand Voice: ${siteInfo.brand_voice}` : ''}`);
    }
    if (segmentId) {
        const segmentInfo = await getSegmentInfo(segmentId);
        if (segmentInfo) {
            const segmentData = {
                name: segmentInfo.name || 'Unnamed Segment',
                description: segmentInfo.description || 'No description available',
                audience_criteria: segmentInfo.criteria || segmentInfo.audience_criteria || 'N/A',
                size: segmentInfo.size || segmentInfo.audience_size || 'Unknown',
                interests: segmentInfo.interests || [],
                pain_points: segmentInfo.pain_points || []
            };
            contextParts.push(`AUDIENCE SEGMENT INFORMATION:
- Name: ${segmentData.name}
- Description: ${segmentData.description}
- Criteria: ${segmentData.audience_criteria}
- Segment Size: ${segmentData.size}
${Array.isArray(segmentData.interests) && segmentData.interests.length > 0 ? `- Interests: ${segmentData.interests.join(', ')}` : ''}
${Array.isArray(segmentData.pain_points) && segmentData.pain_points.length > 0 ? `- Pain Points: ${segmentData.pain_points.join(', ')}` : ''}
${segmentInfo.behaviors ? `- Key Behaviors: ${segmentInfo.behaviors}` : ''}
${segmentInfo.content_preferences ? `- Content Preferences: ${segmentInfo.content_preferences}` : ''}`);
        }
    }
    if (campaignId) {
        const campaignInfo = await getCampaignInfo(campaignId);
        if (campaignInfo) {
            const campaignData = {
                name: campaignInfo.name || 'Unnamed Campaign',
                description: campaignInfo.description || 'No description available',
                goal: campaignInfo.goal || campaignInfo.objective || 'N/A',
                start_date: campaignInfo.start_date || 'N/A',
                end_date: campaignInfo.end_date || 'N/A',
                target_audience: campaignInfo.target_audience || 'N/A',
                channels: campaignInfo.channels || [],
                kpis: campaignInfo.kpis || []
            };
            contextParts.push(`CAMPAIGN INFORMATION:
- Name: ${campaignData.name}
- Description: ${campaignData.description}
- Primary Goal: ${campaignData.goal}
- Timeline: ${campaignData.start_date} to ${campaignData.end_date}
- Target Audience: ${campaignData.target_audience}
${Array.isArray(campaignData.channels) && campaignData.channels.length > 0 ? `- Distribution Channels: ${campaignData.channels.join(', ')}` : ''}
${Array.isArray(campaignData.kpis) && campaignData.kpis.length > 0 ? `- Key Performance Indicators: ${campaignData.kpis.join(', ')}` : ''}
${campaignInfo.budget ? `- Budget: ${campaignInfo.budget}` : ''}
${campaignInfo.messaging ? `- Key Messaging: ${campaignInfo.messaging}` : ''}
${campaignInfo.content_requirements ? `- Content Requirements: ${campaignInfo.content_requirements}` : ''}`);
        }
    }
    return contextParts.join('\n\n');
}
