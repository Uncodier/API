# Site Analysis Storage

This document describes how structured site analysis data is stored in the database.

## Database Schema

The site analysis data is stored in the `site_analysis` table with the following schema:

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Unique identifier for the analysis |
| site_id | uuid | ID of the site the analysis belongs to |
| url_path | text | Specific URL path analyzed |
| structure | jsonb | Structural analysis data in JSON format |
| user_id | uuid | ID of the user who created the analysis |
| created_at | timestamptz | Creation date and time |
| updated_at | timestamptz | Last update date and time |
| status | text | Analysis status (completed, failed, processing) |
| request_time | int4 | Processing time in milliseconds |
| provider | text | AI provider used for analysis |
| model_id | text | Specific model ID used |

## How to Use

### API Usage

To save an analysis to the database when calling the analysis endpoint, you need to:

1. Include `site_id` and `user_id` parameters in your request
2. Set `saveToDatabase: true` in the options object

Example request:

```json
{
  "url": "https://example.com",
  "site_id": "site-uuid",
  "user_id": "user-uuid",
  "options": {
    "saveToDatabase": true,
    "provider": "anthropic",
    "modelId": "claude-3-opus-20240229"
  }
}
```

### Response

When an analysis is saved to the database, the API response will include an `analysis_id` field:

```json
{
  "url": "https://example.com",
  "structuredAnalysis": { /* analysis data */ },
  "requestTime": 12345,
  "timestamp": "2023-06-15T10:30:00.000Z",
  "analysis_id": "uuid-of-saved-analysis"
}
```

### Process Flow

1. When a request with `saveToDatabase: true` is received, an initial record with status `processing` is created
2. The analysis is performed
3. If the analysis completes successfully:
   - The record is updated with the analysis result and status `completed`
4. If the analysis fails:
   - The record is updated with status `failed`

## Database Operations

The following operations are available for site analysis data:

- `createSiteAnalysis`: Create a new analysis record
- `updateSiteAnalysis`: Update an existing analysis
- `updateSiteAnalysisStatus`: Update just the status of an analysis
- `getSiteAnalysisById`: Get an analysis by its ID
- `getSiteAnalysesBySite`: Get all analyses for a specific site

## Implementation

The database operations are implemented in `src/lib/database/site-analysis-db.ts`.

The integration with the analysis process is in `src/app/api/site/analyze/structure/route.ts`. 