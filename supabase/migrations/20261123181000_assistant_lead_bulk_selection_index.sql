-- Run outside a transaction so building the index does not block CRM writes.
CREATE INDEX CONCURRENTLY IF NOT EXISTS assistant_lead_bulk_leads_site_cursor ON public.leads (site_id,id);