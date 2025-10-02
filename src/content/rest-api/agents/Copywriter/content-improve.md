# Content Improve API

API to enhance existing content using AI copywriter agents. This API processes all site content in `draft` state in bulk, applying consistent improvements based on specific goals and updating the content in the database.

## Base Endpoint

```
/api/agents/copywriter/content-improve
```

## Available Methods

### POST - Bulk Improve Draft Content

Improves all site content in `draft` state by consistently applying SEO, readability, and engagement optimizations.

#### URL
```
POST /api/agents/copywriter/content-improve
```

#### Request Body (JSON)

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `siteId` | string (UUID) | Yes | Site ID — all its draft content will be processed |
| `contentIds` | array[string (UUID)] | No | Specific content IDs to improve (if omitted, improves all site draft content) |
| `segmentId` | string (UUID) | No | Audience segment ID |
| `campaignId` | string (UUID) | No | Campaign ID |
| `userId` | string | No | User ID (default: `system`) |
| `agent_id` | string | No | Agent ID (default: `default_copywriter_agent`) |
| `improvementGoals` | array[string] | No | Specific improvement goals |
| `targetAudience` | string\|array[string] | No | Target audience |
| `keywords` | array[string] | No | Keywords for SEO optimization |
| `contentStyle` | string | No | Desired content style |
| `maxLength` | number | No | Max characters per content item |
| `limit` | number | No | Max content items to process (default: 50) |

#### Example Request — Bulk Improve

```json
{
  "siteId": "456e7890-e89b-12d3-a456-426614174001",
  "segmentId": "789e0123-e89b-12d3-a456-426614174002",
  "userId": "user_123",
  "improvementGoals": [
    "Improve readability and structure",
    "Optimize for SEO",
    "Increase engagement",
    "Maintain brand consistency"
  ],
  "targetAudience": [
    "Digital entrepreneurs",
    "Professional marketers"
  ],
  "keywords": [
    "digital marketing",
    "content strategy",
    "SEO",
    "conversion",
    "engagement"
  ],
  "contentStyle": "professional yet accessible",
  "maxLength": 2000,
  "limit": 25
}
```

#### Example Request — Selective Improve

```json
{
  "siteId": "456e7890-e89b-12d3-a456-426614174001",
  "contentIds": [
    "123e4567-e89b-12d3-a456-426614174000",
    "234e5678-e89b-12d3-a456-426614174001",
    "345e6789-e89b-12d3-a456-426614174002"
  ],
  "userId": "user_123",
  "improvementGoals": [
    "Optimize for specific keywords",
    "Improve call-to-action"
  ],
  "keywords": ["product", "sales", "conversion"]
}
```

#### Success Response (200)

```json
{
  "success": true,
  "data": {
    "command_id": "789e0123-e89b-12d3-a456-426614174003",
    "siteId": "456e7890-e89b-12d3-a456-426614174001",
    "segmentId": "789e0123-e89b-12d3-a456-426614174002",
    "campaignId": null,
    "processed_count": 15,
    "updated_count": 14,
    "failed_count": 1,
    "failed_content_ids": ["123e4567-e89b-12d3-a456-426614174000"],
    "original_content": [
      {
        "id": "234e5678-e89b-12d3-a456-426614174001",
        "title": "Original Title 1",
        "description": "Original description",
        "status": "draft"
      },
      {
        "id": "345e6789-e89b-12d3-a456-426614174002",
        "title": "Original Title 2",
        "description": "Original description",
        "status": "draft"
      }
    ],
    "improved_content": [
      {
        "id": "234e5678-e89b-12d3-a456-426614174001",
        "title": "Improved Title Optimized for SEO",
        "description": "Improved description with higher impact and keywords",
        "text": "Improved content with better structure...",
        "status": "improved",
        "updated_at": "2024-01-15T10:30:00Z",
        "metadata": {
          "improved_at": "2024-01-15T10:30:00Z",
          "improved_by": "user_123",
          "improvement_notes": "SEO optimization, structure improvements, stronger CTA",
          "original_score": 65,
          "improved_score": 87,
          "improvements_applied": [
            "Paragraph restructuring",
            "Keyword optimization",
            "Call-to-action improvements",
            "Readability fixes"
          ]
        }
      }
    ],
    "improvements_summary": "Successfully improved 14 out of 15 content items"
  }
}
```

#### Error Responses

**400 — Invalid Parameters**
```json
{
  "success": false,
  "error": {
    "code": "INVALID_REQUEST",
    "message": "siteId is required"
  }
}
```

**400 — Invalid contentIds**
```json
{
  "success": false,
  "error": {
    "code": "INVALID_REQUEST",
    "message": "contentIds must be an array of valid UUIDs"
  }
}
```

**404 — No Draft Content**
```json
{
  "success": false,
  "error": {
    "code": "NO_DRAFT_CONTENT",
    "message": "No draft content found for improvement"
  }
}
```

**500 — Execution Error**
```json
{
  "success": false,
  "error": {
    "code": "COMMAND_EXECUTION_FAILED",
    "message": "The bulk content improvement command did not complete successfully in the expected time"
  }
}
```

### GET — List Draft Content

Returns site content in `draft` state that is available for improvement.

#### URL
```
GET /api/agents/copywriter/content-improve?siteId={siteId}&limit={limit}
```

#### Query Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `siteId` | string (UUID) | Yes | Site ID |
| `segmentId` | string (UUID) | No | Filter by specific segment |
| `campaignId` | string (UUID) | No | Filter by specific campaign |
| `limit` | number | No | Result limit (default: 50) |

#### Example Request

```
GET /api/agents/copywriter/content-improve?siteId=456e7890-e89b-12d3-a456-426614174001&limit=20
```

#### Success Response (200)

```json
{
  "success": true,
  "data": {
    "siteId": "456e7890-e89b-12d3-a456-426614174001",
    "segmentId": null,
    "campaignId": null,
    "draft_content": [
      {
        "id": "123e4567-e89b-12d3-a456-426614174000",
        "title": "Digital Marketing Guide",
        "description": "A complete guide to digital marketing",
        "text": "Article content...",
        "type": "blog_post",
        "status": "draft",
        "created_at": "2024-01-10T09:15:00Z",
        "site_id": "456e7890-e89b-12d3-a456-426614174001",
        "metadata": {
          "estimated_reading_time": 300,
          "keywords": ["marketing", "digital"]
        }
      },
      {
        "id": "234e5678-e89b-12d3-a456-426614174001",
        "title": "Conversion Strategies",
        "description": "How to optimize your sales funnel",
        "text": "Content about conversions...",
        "type": "article",
        "status": "draft",
        "created_at": "2024-01-11T10:20:00Z",
        "site_id": "456e7890-e89b-12d3-a456-426614174001"
      }
    ],
    "total_items": 2
  }
}
```

## Bulk Improvement Flow

1. List draft content via GET
2. Configure improvements (goals, keywords, parameters)
3. Execute bulk improvement via POST with `siteId`
4. Optional selective improvement with `contentIds`
5. Receive results; content is updated in the database

## Benefits of Bulk Improvement

### Consistency
- Unified style across all content
- Consistent terminology and tone
- Homogeneous quality standards

### Efficiency
- Bulk processing in one operation
- Resource optimization and reduced processing time
- Cohesive evaluation of content set

### Strategy
- Holistic view of content strategy
- Coordinated SEO optimization across items
- Unified messaging aligned with business goals

## Content States

- `draft`: Available for bulk improvement
- `improved`: Improved by the agent
- `published`: Published (not included in bulk improvement)

## Improvement Metadata

Each improved content item includes detailed metadata:

- `improved_at`: Improvement timestamp
- `improved_by`: Requesting user
- `improvement_notes`: Notes about applied improvements
- `original_score`: Quality score before improvement
- `improved_score`: Quality score after improvement
- `improvements_applied`: List of specific improvements

## Best Practices

### For Bulk Improvement
1. Define clear goals applicable across content
2. Provide strategic keywords that work across items
3. Specify a consistent style for the whole site
4. Use `limit` to control processing volume
5. Review results to detect patterns and future improvements

### For Selective Improvement
1. Choose content items that benefit from similar improvements
2. Define specific improvements for the selection
3. Ensure alignment with the rest of the content

## Limits and Considerations

- Volume: processes up to 50 items by default (configurable with `limit`)
- Processing time: bulk operations may take up to 2 minutes
- Draft only: only processes content in `draft` state
- Automatic updates: changes are applied directly to the database
- Consistency: maintains coherence across processed items
- Rollback: no automatic rollback; review results

## Error Codes

| Code | Description |
|------|-------------|
| `INVALID_REQUEST` | Invalid request parameters |
| `NO_DRAFT_CONTENT` | No draft content found to improve |
| `COMMAND_EXECUTION_FAILED` | Bulk improvement command failed |
| `NO_IMPROVED_CONTENT` | No improved content generated |
| `DATABASE_UPDATE_FAILED` | Error updating content in database |
| `INTERNAL_SERVER_ERROR` | Internal server error |

## Usage Examples

### Improve Entire Site Draft Content
```javascript
const response = await fetch('/api/agents/copywriter/content-improve', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    siteId: 'site-uuid',
    improvementGoals: [
      'Optimize for SEO',
      'Improve readability',
      'Strengthen calls-to-action'
    ],
    keywords: ['product', 'service', 'solution'],
    contentStyle: 'professional and accessible'
  })
});
```

### Improve Specific Content Items
```javascript
const response = await fetch('/api/agents/copywriter/content-improve', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    siteId: 'site-uuid',
    contentIds: ['content-1-uuid', 'content-2-uuid'],
    improvementGoals: ['Optimize for conversion'],
    targetAudience: 'decision makers'
  })
});
```

### Query Draft Content
```javascript
const response = await fetch(
  '/api/agents/copywriter/content-improve?siteId=site-uuid&limit=20'
);
const data = await response.json();
console.log(`${data.data.total_items} content items available for improvement`);
```