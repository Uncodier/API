-- Script SQL para borrar mensajes de WhatsApp con criterios específicos
-- Este script elimina mensajes que cumplan con los siguientes criterios:
-- - source: "whatsapp" 
-- - status: "sent"
-- - sent_at: "2025-09-30T19:15:19.491Z"
-- - whatsapp_phone: "+528125801883"
-- - template_required: true
-- - twilio_message_id: "MM1350f99c4df2c6416542fdf523a297d5"
-- - role: "assistant"
-- - De un sitio específico (reemplazar 'SITE_ID_AQUI' con el ID real del sitio)

-- IMPORTANTE: Reemplaza 'SITE_ID_AQUI' con el ID real del sitio
-- También puedes ajustar los valores de los criterios según necesites

-- Primero, verificar cuántos mensajes coinciden con los criterios
SELECT 
    m.id,
    m.content,
    m.role,
    m.custom_data,
    m.created_at,
    c.site_id,
    c.visitor_id
FROM messages m
JOIN conversations c ON m.conversation_id = c.id
WHERE 
    m.role = 'assistant'
    AND c.site_id = 'SITE_ID_AQUI'  -- Reemplazar con el ID real del sitio
    AND m.custom_data->>'source' = 'whatsapp'
    AND m.custom_data->>'status' = 'sent'
    AND m.custom_data->>'whatsapp_phone' = '+528125801883'
    AND m.custom_data->>'template_required' = 'true'
    AND m.custom_data->>'twilio_message_id' = 'MM1350f99c4df2c6416542fdf523a297d5'
    AND m.custom_data->>'sent_at' = '2025-09-30T19:15:19.491Z';

-- Si quieres ser más específico y eliminar solo mensajes de un sitio específico,
-- usa esta consulta (reemplaza 'SITE_ID_AQUI' con el ID real del sitio):

DELETE FROM messages 
WHERE id IN (
    SELECT m.id
    FROM messages m
    JOIN conversations c ON m.conversation_id = c.id
    WHERE 
        m.role = 'assistant'
        AND c.site_id = 'SITE_ID_AQUI'  -- Reemplazar con el ID real del sitio
        AND m.custom_data->>'source' = 'whatsapp'
        AND m.custom_data->>'status' = 'sent'
        AND m.custom_data->>'whatsapp_phone' = '+528125801883'
        AND m.custom_data->>'template_required' = 'true'
        AND m.custom_data->>'twilio_message_id' = 'MM1350f99c4df2c6416542fdf523a297d5'
        AND m.custom_data->>'sent_at' = '2025-09-30T19:15:19.491Z'
);

-- Si quieres eliminar TODOS los mensajes que cumplan con estos criterios (sin filtrar por sitio):
-- DELETE FROM messages 
-- WHERE 
--     role = 'assistant'
--     AND custom_data->>'source' = 'whatsapp'
--     AND custom_data->>'status' = 'sent'
--     AND custom_data->>'whatsapp_phone' = '+528125801883'
--     AND custom_data->>'template_required' = 'true'
--     AND custom_data->>'twilio_message_id' = 'MM1350f99c4df2c6416542fdf523a297d5'
--     AND custom_data->>'sent_at' = '2025-09-30T19:15:19.491Z';

-- Script más flexible que permite ajustar los criterios fácilmente:
-- DELETE FROM messages 
-- WHERE 
--     role = 'assistant'
--     AND custom_data->>'source' = 'whatsapp'
--     AND custom_data->>'status' = 'sent'
--     AND custom_data->>'whatsapp_phone' = '+528125801883'  -- Cambiar por el teléfono deseado
--     AND custom_data->>'template_required' = 'true'
--     AND custom_data->>'twilio_message_id' = 'MM1350f99c4df2c6416542fdf523a297d5'  -- Cambiar por el ID deseado
--     AND custom_data->>'sent_at' = '2025-09-30T19:15:19.491Z'  -- Cambiar por la fecha deseada
--     AND conversation_id IN (
--         SELECT id FROM conversations WHERE site_id = 'SITE_ID_AQUI'  -- Reemplazar con el ID real del sitio
--     );

-- Para obtener el ID del sitio, puedes usar esta consulta:
-- SELECT id, name, domain FROM sites WHERE name ILIKE '%nombre_del_sitio%' OR domain ILIKE '%dominio%';
