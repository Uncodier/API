-- Alteramos la tabla messages para renombrar sender_type a role
ALTER TABLE messages 
RENAME COLUMN sender_type TO role;

-- Actualizamos la restricción de validación para que use role
ALTER TABLE messages 
DROP CONSTRAINT IF EXISTS valid_sender_type;

ALTER TABLE messages 
ADD CONSTRAINT valid_role CHECK (
    role IN (
        'visitor', 'agent', 'user', 'system', 'assistant'
    )
);

-- Renombramos el índice
DROP INDEX IF EXISTS idx_messages_sender_type;
CREATE INDEX idx_messages_role ON messages(role);

-- Actualizamos los comentarios
COMMENT ON COLUMN messages.role IS 'Tipo de remitente (visitor, agent, user, system, assistant)';

-- Actualizamos cualquier registro existente que tenga role 'agent' a 'assistant' si es necesario
UPDATE messages 
SET role = 'assistant' 
WHERE role = 'agent' AND agent_id IS NOT NULL; 