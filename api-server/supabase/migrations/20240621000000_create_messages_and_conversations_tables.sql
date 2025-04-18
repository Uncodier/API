-- Create conversations table
CREATE TABLE IF NOT EXISTS conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    visitor_id UUID,
    agent_id UUID,
    user_id UUID,
    lead_id UUID,
    site_id UUID,
    status TEXT DEFAULT 'active',
    title TEXT,
    custom_data JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    last_message_at TIMESTAMPTZ,
    CONSTRAINT fk_visitor
        FOREIGN KEY(visitor_id)
        REFERENCES visitors(id)
        ON DELETE SET NULL,
    CONSTRAINT fk_lead
        FOREIGN KEY(lead_id)
        REFERENCES leads(id)
        ON DELETE SET NULL
);

-- Add indexes for conversations
CREATE INDEX IF NOT EXISTS idx_conversations_visitor_id ON conversations(visitor_id);
CREATE INDEX IF NOT EXISTS idx_conversations_agent_id ON conversations(agent_id);
CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_lead_id ON conversations(lead_id);
CREATE INDEX IF NOT EXISTS idx_conversations_site_id ON conversations(site_id);
CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);
CREATE INDEX IF NOT EXISTS idx_conversations_last_message_at ON conversations(last_message_at);

-- Add comments to conversations table
COMMENT ON TABLE conversations IS 'Stores chat conversations between visitors, agents, and users';
COMMENT ON COLUMN conversations.id IS 'Unique identifier for the conversation';
COMMENT ON COLUMN conversations.visitor_id IS 'Reference to the visitor';
COMMENT ON COLUMN conversations.agent_id IS 'Reference to the AI agent';
COMMENT ON COLUMN conversations.user_id IS 'Reference to the human user/operator';
COMMENT ON COLUMN conversations.lead_id IS 'Reference to the lead if visitor is identified';
COMMENT ON COLUMN conversations.site_id IS 'Site identifier';
COMMENT ON COLUMN conversations.status IS 'Conversation status (active, closed, archived)';
COMMENT ON COLUMN conversations.title IS 'Conversation title';
COMMENT ON COLUMN conversations.custom_data IS 'Additional custom data as JSON';
COMMENT ON COLUMN conversations.created_at IS 'Record creation timestamp';
COMMENT ON COLUMN conversations.updated_at IS 'Record last update timestamp';
COMMENT ON COLUMN conversations.last_message_at IS 'Timestamp of the last message';

-- Create messages table
CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL,
    visitor_id UUID,
    agent_id UUID,
    user_id UUID,
    lead_id UUID,
    command_id UUID,
    content TEXT NOT NULL,
    sender_type TEXT NOT NULL,
    read_at TIMESTAMPTZ,
    custom_data JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT fk_conversation
        FOREIGN KEY(conversation_id)
        REFERENCES conversations(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_visitor
        FOREIGN KEY(visitor_id)
        REFERENCES visitors(id)
        ON DELETE SET NULL,
    CONSTRAINT fk_lead
        FOREIGN KEY(lead_id)
        REFERENCES leads(id)
        ON DELETE SET NULL,
    CONSTRAINT valid_sender_type CHECK (
        sender_type IN (
            'visitor', 'agent', 'user', 'system'
        )
    )
);

-- Add indexes for messages
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_visitor_id ON messages(visitor_id);
CREATE INDEX IF NOT EXISTS idx_messages_agent_id ON messages(agent_id);
CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_lead_id ON messages(lead_id);
CREATE INDEX IF NOT EXISTS idx_messages_command_id ON messages(command_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender_type ON messages(sender_type);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);

-- Add comments to messages table
COMMENT ON TABLE messages IS 'Stores individual messages in conversations';
COMMENT ON COLUMN messages.id IS 'Unique identifier for the message';
COMMENT ON COLUMN messages.conversation_id IS 'Reference to the conversation';
COMMENT ON COLUMN messages.visitor_id IS 'Reference to the visitor';
COMMENT ON COLUMN messages.agent_id IS 'Reference to the AI agent';
COMMENT ON COLUMN messages.user_id IS 'Reference to the human user/operator';
COMMENT ON COLUMN messages.lead_id IS 'Reference to the lead if visitor is identified';
COMMENT ON COLUMN messages.command_id IS 'Reference to the command that generated this message';
COMMENT ON COLUMN messages.content IS 'Message content';
COMMENT ON COLUMN messages.sender_type IS 'Type of sender (visitor, agent, user, system)';
COMMENT ON COLUMN messages.read_at IS 'Timestamp when message was read';
COMMENT ON COLUMN messages.custom_data IS 'Additional custom data as JSON';
COMMENT ON COLUMN messages.created_at IS 'Record creation timestamp';
COMMENT ON COLUMN messages.updated_at IS 'Record last update timestamp';

-- Create function to update conversation last_message_at when new message is added
CREATE OR REPLACE FUNCTION update_conversation_last_message_time()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE conversations
    SET last_message_at = NEW.created_at,
        updated_at = NOW()
    WHERE id = NEW.conversation_id;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for conversation update on message insert
DROP TRIGGER IF EXISTS on_message_insert ON messages;
CREATE TRIGGER on_message_insert
    AFTER INSERT ON messages
    FOR EACH ROW
    EXECUTE FUNCTION update_conversation_last_message_time();

-- Add RLS policies
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- Create policies for conversations
CREATE POLICY "Enable read access for authenticated users" ON conversations
    FOR SELECT
    TO authenticated
    USING (true);

CREATE POLICY "Enable insert for authenticated users" ON conversations
    FOR INSERT
    TO authenticated
    WITH CHECK (true);

CREATE POLICY "Enable update for authenticated users" ON conversations
    FOR UPDATE
    TO authenticated
    USING (true);

-- Create policies for messages
CREATE POLICY "Enable read access for authenticated users" ON messages
    FOR SELECT
    TO authenticated
    USING (true);

CREATE POLICY "Enable insert for authenticated users" ON messages
    FOR INSERT
    TO authenticated
    WITH CHECK (true);

CREATE POLICY "Enable update for authenticated users" ON messages
    FOR UPDATE
    TO authenticated
    USING (true); 