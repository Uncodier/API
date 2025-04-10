-- Create custom enum type for command status
CREATE TYPE command_status AS ENUM ('pending', 'running', 'completed', 'failed', 'cancelled');

-- Create commands table
CREATE TABLE IF NOT EXISTS commands (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    task TEXT NOT NULL,
    status command_status NOT NULL DEFAULT 'pending',
    description TEXT,
    results JSONB DEFAULT '[]'::jsonb,
    targets JSONB DEFAULT '[]'::jsonb,
    tools JSONB DEFAULT '[]'::jsonb,
    context TEXT,
    supervisor JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    completion_date TIMESTAMPTZ,
    duration INTEGER,
    model TEXT,
    agent_id UUID,
    user_id UUID NOT NULL
);

-- Add indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_commands_user_id ON commands(user_id);
CREATE INDEX IF NOT EXISTS idx_commands_agent_id ON commands(agent_id);
CREATE INDEX IF NOT EXISTS idx_commands_status ON commands(status);
CREATE INDEX IF NOT EXISTS idx_commands_created_at ON commands(created_at);

-- Add comment to the table
COMMENT ON TABLE commands IS 'Stores AI command execution data and results';

-- Add comments to columns
COMMENT ON COLUMN commands.id IS 'Unique identifier for the command';
COMMENT ON COLUMN commands.task IS 'The command task/instruction';
COMMENT ON COLUMN commands.status IS 'Status of the command execution (pending, running, completed, failed, cancelled)';
COMMENT ON COLUMN commands.description IS 'Description of the command';
COMMENT ON COLUMN commands.results IS 'Array of command execution results';
COMMENT ON COLUMN commands.targets IS 'Array of command targets';
COMMENT ON COLUMN commands.tools IS 'Array of tools used by the command';
COMMENT ON COLUMN commands.context IS 'Context for the command execution';
COMMENT ON COLUMN commands.supervisor IS 'Array of supervisor objects for the command';
COMMENT ON COLUMN commands.created_at IS 'Record creation timestamp';
COMMENT ON COLUMN commands.updated_at IS 'Record last update timestamp';
COMMENT ON COLUMN commands.completion_date IS 'Timestamp when command completed';
COMMENT ON COLUMN commands.duration IS 'Command execution duration in milliseconds';
COMMENT ON COLUMN commands.model IS 'AI model used for execution';
COMMENT ON COLUMN commands.agent_id IS 'ID of the agent that executed the command';
COMMENT ON COLUMN commands.user_id IS 'ID of the user who created the command';

-- Add RLS policies
ALTER TABLE commands ENABLE ROW LEVEL SECURITY;

-- Create policy so users can only see their own commands
CREATE POLICY "Users can view their own commands" ON commands
    FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

-- Create policy so users can insert their own commands
CREATE POLICY "Users can insert their own commands" ON commands
    FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = user_id);

-- Create policy so users can update their own commands
CREATE POLICY "Users can update their own commands" ON commands
    FOR UPDATE
    TO authenticated
    USING (auth.uid() = user_id);

-- Create function to handle command updates
CREATE OR REPLACE FUNCTION handle_command_update()
RETURNS TRIGGER AS $$
BEGIN
    -- Update the updated_at timestamp
    NEW.updated_at = NOW();
    
    -- If status is changing to completed/failed, set completion_date
    IF (OLD.status <> 'completed' AND OLD.status <> 'failed') AND 
       (NEW.status = 'completed' OR NEW.status = 'failed') THEN
        NEW.completion_date = NOW();
        
        -- Calculate duration if not provided
        IF NEW.duration IS NULL THEN
            NEW.duration = EXTRACT(EPOCH FROM (NOW() - OLD.created_at)) * 1000;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for command updates
DROP TRIGGER IF EXISTS on_command_update ON commands;
CREATE TRIGGER on_command_update
    BEFORE UPDATE ON commands
    FOR EACH ROW
    EXECUTE FUNCTION handle_command_update();

-- Create function to handle command insertion
CREATE OR REPLACE FUNCTION handle_command_insert()
RETURNS TRIGGER AS $$
BEGIN
    -- Ensure created_at and updated_at are set
    NEW.created_at = COALESCE(NEW.created_at, NOW());
    NEW.updated_at = NOW();
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for command insertion
DROP TRIGGER IF EXISTS on_command_insert ON commands;
CREATE TRIGGER on_command_insert
    BEFORE INSERT ON commands
    FOR EACH ROW
    EXECUTE FUNCTION handle_command_insert(); 