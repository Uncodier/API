-- Add command_id column to all tables dynamically
-- This migration adds a command_id column to all tables to link them with the commands table

-- Function to add command_id to all tables
CREATE OR REPLACE FUNCTION add_command_id_to_all_tables()
RETURNS void AS $$
DECLARE
    table_record RECORD;
    sql_query TEXT;
BEGIN
    -- Loop through all tables in the public schema
    FOR table_record IN 
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_type = 'BASE TABLE'
        AND table_name != 'commands' -- Exclude the commands table itself
    LOOP
        -- Check if command_id column already exists
        IF NOT EXISTS (
            SELECT 1 
            FROM information_schema.columns 
            WHERE table_schema = 'public' 
            AND table_name = table_record.table_name 
            AND column_name = 'command_id'
        ) THEN
            -- Add command_id column
            sql_query := 'ALTER TABLE ' || table_record.table_name || 
                        ' ADD COLUMN command_id UUID, ' ||
                        'ADD CONSTRAINT fk_command_' || table_record.table_name || 
                        ' FOREIGN KEY(command_id) REFERENCES commands(id) ON DELETE CASCADE';
            
            EXECUTE sql_query;
            
            -- Add index for better query performance
            sql_query := 'CREATE INDEX idx_' || table_record.table_name || '_command_id ON ' || 
                        table_record.table_name || '(command_id)';
            
            EXECUTE sql_query;
            
            -- Add comment to the column
            sql_query := 'COMMENT ON COLUMN ' || table_record.table_name || '.command_id IS ''Reference to the command that created this record''';
            
            EXECUTE sql_query;
            
            RAISE NOTICE 'Added command_id to table: %', table_record.table_name;
        ELSE
            RAISE NOTICE 'Table % already has command_id column', table_record.table_name;
        END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Execute the function
SELECT add_command_id_to_all_tables();

-- Drop the function after use
DROP FUNCTION add_command_id_to_all_tables(); 