-- Crear tabla para almacenar templates de WhatsApp de Twilio
CREATE TABLE IF NOT EXISTS whatsapp_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_sid TEXT NOT NULL, -- SID del template en Twilio
    template_name TEXT NOT NULL, -- Nombre amigable del template
    content TEXT NOT NULL, -- Contenido del template
    original_message TEXT, -- Mensaje original que generó el template
    site_id UUID NOT NULL, -- Referencia al sitio
    account_sid TEXT NOT NULL, -- Account SID de Twilio para este template
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'pending', 'failed')),
    language TEXT DEFAULT 'es', -- Idioma del template
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_used TIMESTAMP WITH TIME ZONE,
    usage_count INTEGER DEFAULT 0,
    
    -- Índices para mejorar rendimiento
    CONSTRAINT whatsapp_templates_unique_sid UNIQUE (template_sid),
    CONSTRAINT whatsapp_templates_unique_name_site UNIQUE (template_name, site_id)
);

-- Crear índices para optimizar consultas
CREATE INDEX IF NOT EXISTS idx_whatsapp_templates_site_id ON whatsapp_templates(site_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_templates_account_sid ON whatsapp_templates(account_sid);
CREATE INDEX IF NOT EXISTS idx_whatsapp_templates_status ON whatsapp_templates(status);
CREATE INDEX IF NOT EXISTS idx_whatsapp_templates_created_at ON whatsapp_templates(created_at);
CREATE INDEX IF NOT EXISTS idx_whatsapp_templates_last_used ON whatsapp_templates(last_used);

-- Función para actualizar updated_at automáticamente
CREATE OR REPLACE FUNCTION update_whatsapp_templates_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger para actualizar updated_at
CREATE TRIGGER trigger_update_whatsapp_templates_updated_at
    BEFORE UPDATE ON whatsapp_templates
    FOR EACH ROW
    EXECUTE FUNCTION update_whatsapp_templates_updated_at();

-- Función para incrementar usage_count cuando se usa un template
CREATE OR REPLACE FUNCTION increment_template_usage(template_sid_param TEXT)
RETURNS VOID AS $$
BEGIN
    UPDATE whatsapp_templates 
    SET 
        usage_count = COALESCE(usage_count, 0) + 1,
        last_used = CURRENT_TIMESTAMP
    WHERE template_sid = template_sid_param;
END;
$$ LANGUAGE plpgsql;

-- Comentarios para documentar la tabla
COMMENT ON TABLE whatsapp_templates IS 'Almacena templates de WhatsApp de Twilio para manejar ventana de respuesta';
COMMENT ON COLUMN whatsapp_templates.template_sid IS 'SID único del template en Twilio';
COMMENT ON COLUMN whatsapp_templates.template_name IS 'Nombre amigable del template generado automáticamente';
COMMENT ON COLUMN whatsapp_templates.content IS 'Contenido procesado del template';
COMMENT ON COLUMN whatsapp_templates.original_message IS 'Mensaje original que generó este template';
COMMENT ON COLUMN whatsapp_templates.site_id IS 'ID del sitio al que pertenece este template';
COMMENT ON COLUMN whatsapp_templates.account_sid IS 'Account SID de Twilio asociado';
COMMENT ON COLUMN whatsapp_templates.status IS 'Estado del template: active, inactive, pending, failed';
COMMENT ON COLUMN whatsapp_templates.usage_count IS 'Número de veces que se ha usado este template';
COMMENT ON COLUMN whatsapp_templates.last_used IS 'Última vez que se usó este template'; 