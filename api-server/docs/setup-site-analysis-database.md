# Site Analysis Database Configuration

This document explains how to configure the database for storing site analysis data.

## Using the Existing Analysis Table

The site analysis feature uses the existing `analysis` table in the database. No additional table creation is required if you already have this table.

## Table Structure Requirements

The `analysis` table should have the following structure:

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| site_id | UUID | ID of the site the analysis belongs to |
| url_path | TEXT | The specific URL path analyzed |
| structure | JSONB | The analysis data in JSON format |
| user_id | UUID | ID of the user who created the analysis |
| created_at | TIMESTAMPTZ | Creation timestamp |
| updated_at | TIMESTAMPTZ | Last update timestamp |
| status | TEXT | Status of the analysis ('completed', 'failed', 'processing') |
| request_time | INTEGER | Processing time in milliseconds |
| provider | TEXT | AI provider used for the analysis |
| model_id | TEXT | Model ID used for the analysis |

## Testing Your Database Configuration

To verify your database configuration works with the site analysis feature:

1. Make sure you have the correct Supabase credentials in your environment variables:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`

2. Use the API Tester in the documentation with:
   - A valid `site_id` (UUID)
   - A valid `user_id` (UUID)
   - The "Save to Database" option enabled

3. Check the Supabase Table Editor to see if your analysis appears in the `analysis` table.

## Troubleshooting

If you encounter errors when saving analyses:

1. Check if the `analysis` table exists and has the required columns
2. Verify you have the right permissions to access the table
3. Check if Row Level Security (RLS) policies are preventing your operations
4. Look at the API response for detailed error messages in the `database_error` field

## Database Operations

The site analysis database operations are implemented in `src/lib/database/site-analysis-db.ts`. These include:

- `createSiteAnalysis`: Create a new analysis record
- `updateSiteAnalysis`: Update an existing analysis
- `updateSiteAnalysisStatus`: Update just the status of an analysis
- `getSiteAnalysisById`: Get an analysis by its ID
- `getSiteAnalysesBySite`: Get all analyses for a specific site 