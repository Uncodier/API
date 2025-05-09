-- Actualizar la restricción de validación para incluir 'team_member' y asegurarse de que 'visitor' está correctamente incluido
ALTER TABLE messages 
DROP CONSTRAINT IF EXISTS valid_role;

ALTER TABLE messages 
ADD CONSTRAINT valid_role CHECK (
    role IN (
        'visitor', 'agent', 'user', 'system', 'assistant', 'team_member'
    )
);

-- Verificar y corregir cualquier mensaje con roles incorrectos
UPDATE messages 
SET role = 'assistant' 
WHERE role = 'agent'; 