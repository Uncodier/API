import React from 'react';
import { MethodChip } from '../../../components/MethodChip';

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
  audioToText: { title: withPost('Audio to Text') },
  campaigns: { title: withPost('Campaigns') },
  configureEmail: { title: withPost('Configure Email') },
  configureWhatsApp: { title: withPost('Configure WhatsApp') },
  content: { title: withPost('Content') },
  conversations: { title: withGet('Conversations') },
  createSecret: { title: withPost('Create Secret') },
  copywriting: { title: withPost('Copywriting') },
  createIcpMining: { title: withPost('Create ICP Mining') },
  deals: { title: withPost('Deals') },
  quotations: { title: withPost('Quotations') },
  quotation_items: { title: withPost('Quotation Items') },
  purchases: { title: withPost('Purchases') },
  purchase_items: { title: withPost('Purchase Items') },
  entitlements: { title: withPost('Entitlements') },
  subscription_plan_items: { title: withPost('Subscription Plan Items') },
  catalog_commerce: { title: withPost('Catalog Commerce') },
  calendars: { title: withPost('Calendars') },
  categories: { title: withPost('Categories') },
  reservation_schedules: { title: withPost('Reservation Schedules') },
  reservations: { title: withPost('Reservations') },
  checkout: { title: withPost('Checkout') },
  // subscriptions: { title: withPost('Subscriptions') },
  // price_lists: { title: withPost('Price Lists') },
  // pass_redeemable_items: { title: withPost('Pass Redeemable Items') },
  generateImage: { title: withPost('Generate Image') },
  generateVideo: { title: withPost('Generate Video') },
  generateAudio: { title: withPost('Generate Audio') },
  getFinderCategoryIds: { title: withPost('Get Finder Category IDs') },
  instancePlan: { title: withPost('Instance Plan') },
  instanceLogs: { title: withPost('Instance Logs') },
  leads: { title: withPost('Leads') },
  memories: { title: withPost('Memories') },
  messages: { title: withGet('Messages') },
  instance: { title: withPost('Instance') },
  publish: { title: withPost('Publish') },
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
