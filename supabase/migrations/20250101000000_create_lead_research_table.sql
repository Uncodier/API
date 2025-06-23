-- Create lead_research table
CREATE TABLE IF NOT EXISTS lead_research (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    site_id UUID NOT NULL,
    lead_id UUID NOT NULL,
    user_id UUID NOT NULL,
    agent_id UUID,
    command_id UUID,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'research',
    research_type TEXT NOT NULL DEFAULT 'standard',
    status TEXT NOT NULL DEFAULT 'completed',
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT fk_site
        FOREIGN KEY(site_id)
        REFERENCES sites(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_lead
        FOREIGN KEY(lead_id)
        REFERENCES leads(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_user
        FOREIGN KEY(user_id)
        REFERENCES auth.users(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_agent
        FOREIGN KEY(agent_id)
        REFERENCES agents(id)
        ON DELETE SET NULL,
    CONSTRAINT fk_command
        FOREIGN KEY(command_id)
        REFERENCES commands(id)
        ON DELETE SET NULL,
    CONSTRAINT valid_category CHECK (
        category IN (
            'research', 'recommendations', 'analysis', 'intelligence'
        )
    ),
    CONSTRAINT valid_research_type CHECK (
        research_type IN (
            'basic', 'standard', 'comprehensive'
        )
    ),
    CONSTRAINT valid_status CHECK (
        status IN (
            'pending', 'in_progress', 'completed', 'failed'
        )
    )
);

-- Add indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_lead_research_site_id ON lead_research(site_id);
CREATE INDEX IF NOT EXISTS idx_lead_research_lead_id ON lead_research(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_research_user_id ON lead_research(user_id);
CREATE INDEX IF NOT EXISTS idx_lead_research_agent_id ON lead_research(agent_id);
CREATE INDEX IF NOT EXISTS idx_lead_research_command_id ON lead_research(command_id);
CREATE INDEX IF NOT EXISTS idx_lead_research_category ON lead_research(category);
CREATE INDEX IF NOT EXISTS idx_lead_research_research_type ON lead_research(research_type);
CREATE INDEX IF NOT EXISTS idx_lead_research_status ON lead_research(status);
CREATE INDEX IF NOT EXISTS idx_lead_research_created_at ON lead_research(created_at);

-- Add GIN index for metadata JSON queries
CREATE INDEX IF NOT EXISTS idx_lead_research_metadata ON lead_research USING GIN (metadata);

-- Add comments to the table and columns
COMMENT ON TABLE lead_research IS 'Stores lead research results and analysis data';
COMMENT ON COLUMN lead_research.id IS 'Unique identifier for the research record';
COMMENT ON COLUMN lead_research.site_id IS 'Reference to the site where the lead originated';
COMMENT ON COLUMN lead_research.lead_id IS 'Reference to the lead being researched';
COMMENT ON COLUMN lead_research.user_id IS 'Reference to the user who requested the research';
COMMENT ON COLUMN lead_research.agent_id IS 'Reference to the agent that performed the research';
COMMENT ON COLUMN lead_research.command_id IS 'Reference to the command that generated this research';
COMMENT ON COLUMN lead_research.title IS 'Title of the research finding or analysis';
COMMENT ON COLUMN lead_research.content IS 'Detailed content of the research result';
COMMENT ON COLUMN lead_research.category IS 'Category of research (research, recommendations, analysis, intelligence)';
COMMENT ON COLUMN lead_research.research_type IS 'Type/depth of research (basic, standard, comprehensive)';
COMMENT ON COLUMN lead_research.status IS 'Status of the research (pending, in_progress, completed, failed)';
COMMENT ON COLUMN lead_research.metadata IS 'Additional metadata as JSON (confidence scores, sources, etc.)';
COMMENT ON COLUMN lead_research.created_at IS 'Record creation timestamp';
COMMENT ON COLUMN lead_research.updated_at IS 'Record last update timestamp';

-- Enable RLS
ALTER TABLE lead_research ENABLE ROW LEVEL SECURITY;

-- Create RLS policies
CREATE POLICY "Users can view their own lead research" ON lead_research
FOR SELECT USING (
    auth.uid() = user_id
);

CREATE POLICY "Users can insert their own lead research" ON lead_research
FOR INSERT WITH CHECK (
    auth.uid() = user_id
);

CREATE POLICY "Users can update their own lead research" ON lead_research
FOR UPDATE USING (
    auth.uid() = user_id
);

CREATE POLICY "Users can delete their own lead research" ON lead_research
FOR DELETE USING (
    auth.uid() = user_id
);

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_lead_research_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for updated_at
CREATE TRIGGER lead_research_updated_at
    BEFORE UPDATE ON lead_research
    FOR EACH ROW
    EXECUTE FUNCTION update_lead_research_updated_at(); 