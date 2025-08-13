-- Add channel column to conversations table
-- This migration adds a channel column to track the communication channel used for conversations
-- Date: 2025-01-09

-- Add channel column to conversations table
ALTER TABLE public.conversations 
ADD COLUMN IF NOT EXISTS channel TEXT;

-- Add index for better query performance
CREATE INDEX IF NOT EXISTS idx_conversations_channel ON public.conversations(channel);

-- Add comment to explain the column purpose
COMMENT ON COLUMN public.conversations.channel IS 'Communication channel used for the conversation (email, whatsapp, notification, etc.)';

-- Update existing conversations to have a default channel value if needed
UPDATE public.conversations 
SET channel = 'unknown' 
WHERE channel IS NULL;
