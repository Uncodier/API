-- Update existing requirement_type enum to add 'payment' type
-- Description: Adds 'payment' to the existing requirement_type enum for budget deployment and payment-related tasks

ALTER TYPE requirement_type ADD VALUE 'payment'; 