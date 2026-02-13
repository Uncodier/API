/**
 * Assistant Protocol Wrapper for Update Site Settings Tool
 * Formats the tool for OpenAI/assistant compatibility
 */

import { tool } from 'scrapybara/tools';
import { z } from 'zod';
import type { UbuntuInstance } from 'scrapybara';
import { updateSiteSettingsCore } from './route';

export interface UpdateSiteSettingsToolParams {
  about?: string;
  company_size?: string;
  industry?: string;
  branding?: any;
  customer_journey?: any;
  products?: any[];
  services?: any[];
  swot?: any;
  locations?: any[];
  marketing_budget?: any;
  marketing_channels?: any[];
  social_media?: any[];
  team_members?: any[];
  team_roles?: any[];
  org_structure?: any;
  competitors?: any[];
  goals?: any;
  channels?: any;
  business_hours?: any;
  press_releases?: any[];
  partnerships?: any[];
  competitor_info?: any;
  diversity_info?: any;
  office_locations?: any[];
}

/**
 * Creates an updateSiteSettings tool for OpenAI/assistant compatibility
 * @param site_id - The site ID associated with the settings
 * @returns Tool definition compatible with OpenAI function calling
 */
export function updateSiteSettingsTool(site_id: string) {
  return {
    name: 'update_site_settings',
    description: 'Update the site business settings, context (about, industry, etc.), and copywriting guidelines (branding, voice, tone). Use this tool when you need to update the company profile, brand voice, target audience, products, or other business configuration. Provide only the fields you want to update.',
    parameters: {
      type: 'object',
      properties: {
        about: {
          type: 'string',
          description: 'A comprehensive description of the company, its mission, and what it does. This serves as the primary context for the AI.',
        },
        company_size: {
          type: 'string',
          description: 'The size of the company (e.g., "1-10", "11-50", "Enterprise").',
        },
        industry: {
          type: 'string',
          description: 'The primary industry the company operates in.',
        },
        branding: {
          type: 'object',
          description: 'Brand identity, voice, tone, and guidelines. Includes brand_pyramid, brand_archetype, color_palette, typography, voice_and_tone (communication_style, personality_traits, forbidden_words, preferred_phrases), brand_guidelines (do_list, dont_list), and brand_assets.',
        },
        customer_journey: {
          type: 'object',
          description: 'Configuration for customer journey stages (awareness, consideration, decision, purchase, retention, referral). Each stage contains metrics, actions, and tactics.',
        },
        products: {
          type: 'array',
          description: 'List of products offered by the company.',
          items: { type: 'object' }
        },
        services: {
          type: 'array',
          description: 'List of services offered by the company.',
          items: { type: 'object' }
        },
        swot: {
          type: 'object',
          description: 'SWOT analysis (strengths, weaknesses, opportunities, threats).',
        },
        locations: {
          type: 'array',
          description: 'Physical locations of the business.',
          items: { type: 'object' }
        },
        marketing_budget: {
          type: 'object',
          description: 'Marketing budget allocation and tracking.',
        },
        marketing_channels: {
          type: 'array',
          description: 'Configuration and performance of marketing channels.',
          items: { type: 'object' }
        },
        social_media: {
          type: 'array',
          description: 'Social media profiles and settings.',
          items: { type: 'object' }
        },
        team_members: {
          type: 'array',
          description: 'Team members and their roles.',
          items: { type: 'object' }
        },
        team_roles: {
          type: 'array',
          description: 'Definitions of team roles and permissions.',
          items: { type: 'object' }
        },
        org_structure: {
          type: 'object',
          description: 'Organizational structure and hierarchy.',
        },
        competitors: {
          type: 'array',
          description: 'List of competitors and analysis.',
          items: { type: 'object' }
        },
        goals: {
          type: 'object',
          description: 'Business goals (quarterly, yearly, etc.).',
        },
        channels: {
          type: 'object',
          description: 'Communication channel configurations (email, whatsapp, etc.).',
        },
        business_hours: {
          type: 'object',
          description: 'Company business hours.',
        },
        press_releases: {
          type: 'array',
          description: 'Company press releases and news.',
          items: { type: 'object' }
        },
        partnerships: {
          type: 'array',
          description: 'Company partnerships and alliances.',
          items: { type: 'object' }
        },
        competitor_info: {
          type: 'object',
          description: 'Detailed competitive intelligence.',
        },
        diversity_info: {
          type: 'object',
          description: 'Diversity and inclusion information.',
        },
        office_locations: {
          type: 'array',
          description: 'Detailed office location information.',
          items: { type: 'object' }
        },
      },
      required: [],
    },
    execute: async (args: UpdateSiteSettingsToolParams) => {
      try {
        console.log(`[UpdateSiteSettingsTool] 🔧 Executing settings update for site: ${site_id}`);
        return await updateSiteSettingsCore(site_id, args);
      } catch (error: any) {
        console.error(`[UpdateSiteSettingsTool] ❌ Error executing tool:`, error);
        throw error;
      }
    },
  };
}

/**
 * Creates an updateSiteSettings tool for Scrapybara SDK compatibility
 * @param instance - The Scrapybara UbuntuInstance
 * @param site_id - The site ID associated with the settings
 * @returns Tool definition compatible with Scrapybara SDK
 */
export function updateSiteSettingsToolScrapybara(instance: UbuntuInstance, site_id: string) {
  return tool({
    name: 'update_site_settings',
    description: 'Update the site business settings, context (about, industry, etc.), and copywriting guidelines (branding, voice, tone). Use this tool when you need to update the company profile, brand voice, target audience, products, or other business configuration. Provide only the fields you want to update.',
    parameters: z.object({
      about: z.string().optional().describe('A comprehensive description of the company, its mission, and what it does. This serves as the primary context for the AI.'),
      company_size: z.string().optional().describe('The size of the company (e.g., "1-10", "11-50", "Enterprise").'),
      industry: z.string().optional().describe('The primary industry the company operates in.'),
      branding: z.any().optional().describe('Brand identity, voice, tone, and guidelines. Includes brand_pyramid, brand_archetype, color_palette, typography, voice_and_tone (communication_style, personality_traits, forbidden_words, preferred_phrases), brand_guidelines (do_list, dont_list), and brand_assets.'),
      customer_journey: z.any().optional().describe('Configuration for customer journey stages (awareness, consideration, decision, purchase, retention, referral). Each stage contains metrics, actions, and tactics.'),
      products: z.array(z.any()).optional().describe('List of products offered by the company.'),
      services: z.array(z.any()).optional().describe('List of services offered by the company.'),
      swot: z.any().optional().describe('SWOT analysis (strengths, weaknesses, opportunities, threats).'),
      locations: z.array(z.any()).optional().describe('Physical locations of the business.'),
      marketing_budget: z.any().optional().describe('Marketing budget allocation and tracking.'),
      marketing_channels: z.array(z.any()).optional().describe('Configuration and performance of marketing channels.'),
      social_media: z.array(z.any()).optional().describe('Social media profiles and settings.'),
      team_members: z.array(z.any()).optional().describe('Team members and their roles.'),
      team_roles: z.array(z.any()).optional().describe('Definitions of team roles and permissions.'),
      org_structure: z.any().optional().describe('Organizational structure and hierarchy.'),
      competitors: z.array(z.any()).optional().describe('List of competitors and analysis.'),
      goals: z.any().optional().describe('Business goals (quarterly, yearly, etc.).'),
      channels: z.any().optional().describe('Communication channel configurations (email, whatsapp, etc.).'),
      business_hours: z.any().optional().describe('Company business hours.'),
      press_releases: z.array(z.any()).optional().describe('Company press releases and news.'),
      partnerships: z.array(z.any()).optional().describe('Company partnerships and alliances.'),
      competitor_info: z.any().optional().describe('Detailed competitive intelligence.'),
      diversity_info: z.any().optional().describe('Diversity and inclusion information.'),
      office_locations: z.array(z.any()).optional().describe('Detailed office location information.'),
    }),
    execute: async (args) => {
      try {
        console.log(`[UpdateSiteSettingsTool-Scrapybara] 🔧 Executing settings update for site: ${site_id}`);
        // Map args to UpdateSiteSettingsToolParams structure if needed
        return await updateSiteSettingsCore(site_id, args as UpdateSiteSettingsToolParams);
      } catch (error: any) {
        console.error(`[UpdateSiteSettingsTool-Scrapybara] ❌ Error executing tool:`, error);
        throw error;
      }
    },
  });
}

/**
 * Helper function to create the tool with a specific site_id
 */
export function createUpdateSiteSettingsTool(site_id: string) {
  if (!site_id || typeof site_id !== 'string') {
    throw new Error('site_id is required and must be a string');
  }
  
  return updateSiteSettingsTool(site_id);
}
