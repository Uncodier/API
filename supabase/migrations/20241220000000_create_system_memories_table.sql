-- Create system_memories table
-- Esta tabla almacena memorias del sistema para evitar repetir operaciones inútiles
-- como búsquedas que no dieron resultados previamente

CREATE TABLE IF NOT EXISTS public.system_memories (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL,
  system_type text NOT NULL,
  key text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_data text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  access_count integer DEFAULT 0,
  last_accessed timestamp with time zone DEFAULT now(),
  expires_at timestamp with time zone,
  command_id uuid,
  CONSTRAINT system_memories_pkey PRIMARY KEY (id),
  CONSTRAINT system_memories_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id),
  CONSTRAINT fk_command_system_memories FOREIGN KEY (command_id) REFERENCES public.commands(id),
  CONSTRAINT system_memories_site_id_system_type_key_key UNIQUE (site_id, system_type, key)
);

-- Add indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_system_memories_site_id ON system_memories(site_id);
CREATE INDEX IF NOT EXISTS idx_system_memories_system_type ON system_memories(system_type);
CREATE INDEX IF NOT EXISTS idx_system_memories_key ON system_memories(key);
CREATE INDEX IF NOT EXISTS idx_system_memories_last_accessed ON system_memories(last_accessed);
CREATE INDEX IF NOT EXISTS idx_system_memories_expires_at ON system_memories(expires_at);
CREATE INDEX IF NOT EXISTS idx_system_memories_command_id ON system_memories(command_id);

-- Add comment to the table
COMMENT ON TABLE system_memories IS 'Stores system-level memories to avoid repeating unsuccessful operations like venue searches that returned no results';

-- Add comments to columns
COMMENT ON COLUMN system_memories.id IS 'Unique identifier for the system memory';
COMMENT ON COLUMN system_memories.site_id IS 'Site identifier to scope memories per site';
COMMENT ON COLUMN system_memories.system_type IS 'Type of system operation (e.g., venue_search, lead_generation)';
COMMENT ON COLUMN system_memories.key IS 'Unique key for the memory within the system_type and site';
COMMENT ON COLUMN system_memories.data IS 'JSON data related to the memory';
COMMENT ON COLUMN system_memories.raw_data IS 'Raw text data if needed';
COMMENT ON COLUMN system_memories.metadata IS 'Additional metadata as JSON';
COMMENT ON COLUMN system_memories.created_at IS 'Record creation timestamp';
COMMENT ON COLUMN system_memories.updated_at IS 'Record last update timestamp';
COMMENT ON COLUMN system_memories.access_count IS 'Number of times this memory has been accessed';
COMMENT ON COLUMN system_memories.last_accessed IS 'Timestamp of last access';
COMMENT ON COLUMN system_memories.expires_at IS 'Optional expiration timestamp for the memory';
COMMENT ON COLUMN system_memories.command_id IS 'Reference to the command that created this memory'; 