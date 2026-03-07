import React from 'react';
import { MethodChip } from '@/components';

const withPost = (label) => (
  <span className="sidebar-title-wrapper">
    <span>{label}</span>
    <MethodChip method="POST" />
  </span>
);

const withGet = (label) => (
  <span className="sidebar-title-wrapper">
    <span>{label}</span>
    <MethodChip method="GET" />
  </span>
);

export default {
  index: 'Overview',
  analyzeICPTotalCount: { title: withPost('Analyze ICP Total Count') },
  assets: { title: withPost('Assets') },
  campaigns: { title: withPost('Campaigns') },
  configureEmail: { title: withPost('Configure Email') },
  configureWhatsApp: { title: withPost('Configure WhatsApp') },
  content: { title: withPost('Content') },
  conversations: { title: withGet('Conversations') },
  copywriting: { title: withPost('Copywriting') },
  createIcpMining: { title: withPost('Create ICP Mining') },
  deals: { title: withPost('Deals') },
  generateImage: { title: withPost('Generate Image') },
  generateVideo: { title: withPost('Generate Video') },
  getFinderCategoryIds: { title: withPost('Get Finder Category IDs') },
  instancePlan: { title: withPost('Instance Plan') },
  leads: { title: withPost('Leads') },
  memories: { title: withPost('Memories') },
  messages: { title: withGet('Messages') },
  renameInstance: { title: withPost('Rename Instance') },
  report: { title: withPost('Report') },
  requirements: { title: withPost('Requirements') },
  requirementStatus: { title: withPost('Requirement Status') },
  sales: { title: withPost('Sales') },
  salesOrder: { title: withPost('Sales Order') },
  scheduling: { title: withPost('Scheduling') },
  searchRegionVenues: 'Search Region Venues',
  segments: { title: withPost('Segments') },
  sendEmail: { title: withPost('Send Email') },
  sendWhatsApp: { title: withPost('Send WhatsApp') },
  systemNotification: { title: withPost('System Notification') },
  tasks: { title: withPost('Tasks') },
  updateSiteSettings: { title: withPost('Update Site Settings') },
  urlToMarkdown: { title: withPost('URL to Markdown') },
  urlToSitemap: { title: withPost('URL to Sitemap') },
  webhooks: { title: withPost('Webhooks') },
  webSearch: { title: withPost('Web Search') },
  whatsappTemplate: { title: withPost('WhatsApp Template') },
  workflows: { title: withPost('Workflows') },
}
