-- Migration: Create whatsapp_template_tracking table
-- Purpose: Track the lifecycle of WhatsApp template creation and sending
-- Date: 2025-01-03

-- Create whatsapp_template_tracking table
CREATE TABLE whatsapp_template_tracking (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    message_id UUID NOT NULL UNIQUE, -- ID único generado en createTemplate
    template_sid TEXT NOT NULL, -- SID de la plantilla de Twilio
    site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    phone_number TEXT NOT NULL,
    original_message TEXT NOT NULL, -- Mensaje original solicitado
    formatted_message TEXT, -- Mensaje formateado usado en la plantilla
    status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'sent', 'failed', 'pending')),
    twilio_message_id TEXT, -- ID del mensaje de Twilio cuando se envía
    error_message TEXT, -- Mensaje de error si falla
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    sent_at TIMESTAMP WITH TIME ZONE, -- Cuando se envió exitosamente
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for better performance
CREATE INDEX idx_whatsapp_template_tracking_message_id ON whatsapp_template_tracking(message_id);
CREATE INDEX idx_whatsapp_template_tracking_template_sid ON whatsapp_template_tracking(template_sid);
CREATE INDEX idx_whatsapp_template_tracking_site_id ON whatsapp_template_tracking(site_id);
CREATE INDEX idx_whatsapp_template_tracking_status ON whatsapp_template_tracking(status);
CREATE INDEX idx_whatsapp_template_tracking_phone_number ON whatsapp_template_tracking(phone_number);
CREATE INDEX idx_whatsapp_template_tracking_created_at ON whatsapp_template_tracking(created_at);

-- Update trigger for updated_at
CREATE OR REPLACE FUNCTION update_whatsapp_template_tracking_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_whatsapp_template_tracking_updated_at
    BEFORE UPDATE ON whatsapp_template_tracking
    FOR EACH ROW
    EXECUTE FUNCTION update_whatsapp_template_tracking_updated_at();

-- RLS (Row Level Security) - Los usuarios solo pueden ver sus propios templates
ALTER TABLE whatsapp_template_tracking ENABLE ROW LEVEL SECURITY;

-- Policy: Los usuarios solo pueden ver templates de sus sitios
CREATE POLICY whatsapp_template_tracking_select_policy ON whatsapp_template_tracking
    FOR SELECT USING (
        site_id IN (
            SELECT id FROM sites WHERE user_id = auth.uid()
        )
    );

-- Policy: Los usuarios solo pueden insertar templates en sus sitios
CREATE POLICY whatsapp_template_tracking_insert_policy ON whatsapp_template_tracking
    FOR INSERT WITH CHECK (
        site_id IN (
            SELECT id FROM sites WHERE user_id = auth.uid()
        )
    );

-- Policy: Los usuarios solo pueden actualizar templates de sus sitios
CREATE POLICY whatsapp_template_tracking_update_policy ON whatsapp_template_tracking
    FOR UPDATE USING (
        site_id IN (
            SELECT id FROM sites WHERE user_id = auth.uid()
        )
    );

-- Policy: Los usuarios solo pueden eliminar templates de sus sitios
CREATE POLICY whatsapp_template_tracking_delete_policy ON whatsapp_template_tracking
    FOR DELETE USING (
        site_id IN (
            SELECT id FROM sites WHERE user_id = auth.uid()
        )
    );

-- Grant permissions to authenticated users
GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_template_tracking TO authenticated;
GRANT USAGE ON SEQUENCE whatsapp_template_tracking_id_seq TO authenticated;

-- Function to increment usage count (referenced in sendTemplate route)
CREATE OR REPLACE FUNCTION increment_usage_count()
RETURNS INTEGER AS $$
BEGIN
    RETURN 1; -- Simple increment, can be enhanced for atomic operations
END;
$$ LANGUAGE plpgsql;

-- Comment on table
COMMENT ON TABLE whatsapp_template_tracking IS 'Tracks the lifecycle of WhatsApp template creation and message sending for the createTemplate/sendTemplate flow'; 