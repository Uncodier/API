-- Add command_id column to all relevant tables
-- This migration adds a command_id column to all tables to link them with the commands table

-- Add command_id to messages table
ALTER TABLE messages
ADD COLUMN IF NOT EXISTS command_id UUID,
ADD CONSTRAINT fk_command_messages
    FOREIGN KEY(command_id)
    REFERENCES commands(id)
    ON DELETE SET NULL;

-- Add index for better query performance
CREATE INDEX IF NOT EXISTS idx_messages_command_id ON messages(command_id);

-- Add comment to the column
COMMENT ON COLUMN messages.command_id IS 'Reference to the command that generated this message';

-- Add command_id to conversations table
ALTER TABLE conversations
ADD COLUMN IF NOT EXISTS command_id UUID,
ADD CONSTRAINT fk_command_conversations
    FOREIGN KEY(command_id)
    REFERENCES commands(id)
    ON DELETE SET NULL;

-- Add index for better query performance
CREATE INDEX IF NOT EXISTS idx_conversations_command_id ON conversations(command_id);

-- Add comment to the column
COMMENT ON COLUMN conversations.command_id IS 'Reference to the command that created this conversation';

-- Add command_id to session_events table
ALTER TABLE session_events
ADD COLUMN IF NOT EXISTS command_id UUID,
ADD CONSTRAINT fk_command_session_events
    FOREIGN KEY(command_id)
    REFERENCES commands(id)
    ON DELETE SET NULL;

-- Add index for better query performance
CREATE INDEX IF NOT EXISTS idx_session_events_command_id ON session_events(command_id);

-- Add comment to the column
COMMENT ON COLUMN session_events.command_id IS 'Reference to the command that generated this event';

-- Add command_id to visitors table if it exists
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 
        FROM information_schema.tables 
        WHERE table_name = 'visitors'
    ) THEN
        ALTER TABLE visitors
        ADD COLUMN IF NOT EXISTS command_id UUID,
        ADD CONSTRAINT fk_command_visitors
            FOREIGN KEY(command_id)
            REFERENCES commands(id)
            ON DELETE SET NULL;

        -- Add index for better query performance
        CREATE INDEX IF NOT EXISTS idx_visitors_command_id ON visitors(command_id);

        -- Add comment to the column
        COMMENT ON COLUMN visitors.command_id IS 'Reference to the command that created this visitor';
    END IF;
END $$;

-- Add command_id to leads table if it exists
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 
        FROM information_schema.tables 
        WHERE table_name = 'leads'
    ) THEN
        ALTER TABLE leads
        ADD COLUMN IF NOT EXISTS command_id UUID,
        ADD CONSTRAINT fk_command_leads
            FOREIGN KEY(command_id)
            REFERENCES commands(id)
            ON DELETE SET NULL;

        -- Add index for better query performance
        CREATE INDEX IF NOT EXISTS idx_leads_command_id ON leads(command_id);

        -- Add comment to the column
        COMMENT ON COLUMN leads.command_id IS 'Reference to the command that created this lead';
    END IF;
END $$;

-- Add command_id to sites table if it exists
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 
        FROM information_schema.tables 
        WHERE table_name = 'sites'
    ) THEN
        ALTER TABLE sites
        ADD COLUMN IF NOT EXISTS command_id UUID,
        ADD CONSTRAINT fk_command_sites
            FOREIGN KEY(command_id)
            REFERENCES commands(id)
            ON DELETE SET NULL;

        -- Add index for better query performance
        CREATE INDEX IF NOT EXISTS idx_sites_command_id ON sites(command_id);

        -- Add comment to the column
        COMMENT ON COLUMN sites.command_id IS 'Reference to the command that created this site';
    END IF;
END $$;

-- Add command_id to agents table if it exists
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 
        FROM information_schema.tables 
        WHERE table_name = 'agents'
    ) THEN
        ALTER TABLE agents
        ADD COLUMN IF NOT EXISTS command_id UUID,
        ADD CONSTRAINT fk_command_agents
            FOREIGN KEY(command_id)
            REFERENCES commands(id)
            ON DELETE SET NULL;

        -- Add index for better query performance
        CREATE INDEX IF NOT EXISTS idx_agents_command_id ON agents(command_id);

        -- Add comment to the column
        COMMENT ON COLUMN agents.command_id IS 'Reference to the command that created this agent';
    END IF;
END $$;

-- Add command_id to users table if it exists
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 
        FROM information_schema.tables 
        WHERE table_name = 'users'
    ) THEN
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS command_id UUID,
        ADD CONSTRAINT fk_command_users
            FOREIGN KEY(command_id)
            REFERENCES commands(id)
            ON DELETE SET NULL;

        -- Add index for better query performance
        CREATE INDEX IF NOT EXISTS idx_users_command_id ON users(command_id);

        -- Add comment to the column
        COMMENT ON COLUMN users.command_id IS 'Reference to the command that created this user';
    END IF;
END $$; 