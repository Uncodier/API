# Database JSONb Sub-Structures Documentation

This document explains the JSONb field structures used in the Market Fit application database. These fields store complex nested data in JSON format within PostgreSQL.

## ⚠️ Cambios Estructurales Importantes

### 🔄 NUEVA ESTRUCTURA DE DIRECCIONES (BREAKING CHANGE)

**Fecha de cambio:** 2024-12-30

La estructura de direcciones en las tablas `leads` y `companies` ha sido **ACTUALIZADA**. Si trabajas en otros proyectos que interactúan con esta base de datos:

#### **Estructura ANTERIOR (DEPRECATED):**
```json
{
  "street": "123 Main St",
  "city": "New York", 
  "zipcode": "10001",
  "address1": "123 Main St"  // ← CAMPO REMOVIDO
}
```

#### **Estructura NUEVA (ACTUAL):**
```json
{
  "full_address": "Dirección completa como string",
  "street": "Nombre de calle y colonia", 
  "external_number": "123",     // ← NUEVO
  "internal_number": "A",       // ← NUEVO  
  "city": "Nombre de ciudad",
  "state": "Estado/Provincia",
  "zip": "Código postal",
  "country": "País",
  "coordinates": { "lat": 0, "lng": 0 }
}
```

#### **📋 Acción Requerida:**
- Actualiza tu código para usar `street`, `external_number`, `internal_number` en lugar de `address1`
- Ejecuta scripts de migración si trabajas con datos existentes
- Todos los registros nuevos usarán la estructura actualizada

---

### Migración de Campos de Tracking: `visitors` → `visitor_sessions`

**Fecha de cambio:** 2024-12-19

Los campos `device`, `browser` y `location` han sido **removidos de la tabla `visitors`** y se mantienen únicamente en la tabla `visitor_sessions`. 

**Razón del cambio:**
- Un visitante puede tener múltiples sesiones desde diferentes dispositivos
- Permite rastrear cambios de ubicación (viajes, VPN)
- Reduce duplicación de datos y mejora la granularidad del tracking

**Migración de datos:**
- Los datos existentes en `visitors.device/browser/location` deben consultarse desde `visitor_sessions`
- Para obtener el dispositivo/ubicación "principal" de un visitante, usar la sesión más reciente o la primera sesión

**Impacto en consultas:**
```sql
-- ❌ ANTERIOR (Ya no funciona)
SELECT device FROM visitors WHERE id = 'visitor_id';

-- ✅ NUEVO (Usar visitor_sessions)
SELECT device FROM visitor_sessions 
WHERE visitor_id = 'visitor_id' 
ORDER BY started_at DESC 
LIMIT 1;
```

## Table of Contents
- [Leads JSONb Fields](#leads-jsonb-fields)
- [Segments JSONb Fields](#segments-jsonb-fields)
- [Settings JSONb Fields](#settings-jsonb-fields)
- [Conversations JSONb Fields](#conversations-jsonb-fields)
- [Agents JSONb Fields](#agents-jsonb-fields)
- [Campaigns JSONb Fields](#campaigns-jsonb-fields)
- [Companies JSONb Fields](#companies-jsonb-fields)
- [Sales JSONb Fields](#sales-jsonb-fields)
- [Visitor Sessions JSONb Fields](#visitor-sessions-jsonb-fields)
- [Session Events JSONb Fields](#session-events-jsonb-fields)
- [Commands JSONb Fields](#commands-jsonb-fields)
- [Profiles JSONb Fields](#profiles-jsonb-fields)
- [Sites JSONb Fields](#sites-jsonb-fields)
- [Task Comments JSONb Fields](#task-comments-jsonb-fields)
- [Other JSONb Fields](#other-jsonb-fields)

---

## Leads JSONb Fields

### `social_networks` (jsonb)
Stores social media profiles and contact information for the lead.

**Default:** `{}`

**Structure:**
```json
{
  "linkedin": "https://linkedin.com/in/username",
  "twitter": "https://twitter.com/username",
  "facebook": "https://facebook.com/username",
  "instagram": "https://instagram.com/username",
  "youtube": "https://youtube.com/channel/username",
  "github": "https://github.com/username",
  "website": "https://personalwebsite.com"
}
```

### `address` (jsonb)
Physical address information for the lead.

**Default:** `{}`

**Structure:**
```json
{
  "zip": "08700",
  "city": "Ciudad de México",
  "state": "CDMX",
  "country": "Mexico",
  "street": "Sur 113-B, Juventino Rosas, Iztacalco",
  "external_number": "2183",
  "internal_number": "B",
  "coordinates": {
    "lat": 19.3900935,
    "lng": -99.10837719999999
  },
  "full_address": "Sur 113-B 2183, Juventino Rosas, Iztacalco, 08700 Ciudad de México, CDMX, Mexico"
}
```

**New fields added:**
- `external_number`: Building/house number (e.g., "2183")
- `internal_number`: Apartment/suite number (e.g., "B", "18")
- `street`: Street name without numbers (replaces deprecated `address1`)

### `company` (jsonb)
Company information when the lead is not linked to the companies table.

**Default:** `{}`

**Structure:**
```json
{
  "name": "Company Name",
  "position": "Job Title",
  "industry": "Technology",
  "size": "11-50",
  "website": "https://company.com",
  "description": "Brief company description"
}
```

### `subscription` (jsonb)
Subscription and billing information for the lead.

**Default:** `{}`

**Structure:**
```json
{
  "plan": "premium",
  "status": "active",
  "billing_cycle": "monthly",
  "amount": 99.99,
  "currency": "USD",
  "start_date": "2024-01-01",
  "end_date": "2024-12-31",
  "auto_renew": true,
  "payment_method": "credit_card"
}
```

### `attribution` (jsonb)
Attribution data when a lead converts.

**Default:** `{}`

**Structure:**
```json
{
  "source": "organic_search",
  "medium": "google",
  "campaign": "summer_2024",
  "content": "blog_post",
  "term": "marketing_automation",
  "conversion_date": "2024-01-15T10:30:00Z",
  "conversion_value": 299.99,
  "first_touch": {
    "source": "social_media",
    "medium": "linkedin",
    "date": "2024-01-01T08:00:00Z"
  },
  "last_touch": {
    "source": "email",
    "medium": "newsletter",
    "date": "2024-01-14T16:45:00Z"
  }
}
```

### `metadata` (jsonb)
Generic metadata for additional lead information.

**Default:** `{}`

**Structure:**
```json
{
  "lead_score": 85,
  "interests": ["marketing", "automation", "analytics"],
  "preferences": {
    "communication": "email",
    "frequency": "weekly",
    "content_type": "newsletter"
  },
  "custom_fields": {
    "field_name": "field_value"
  }
}
```

---

## Segments JSONb Fields

### `analysis` (jsonb)
Analytical data about segment characteristics and behaviors.

**Structure:**
```json
{
  "demographic_data": {
    "age_range": "25-45",
    "income_level": "high",
    "education": "college_graduate",
    "location": "urban"
  },
  "behavioral_patterns": {
    "purchasing_frequency": "monthly",
    "preferred_channels": ["email", "social_media"],
    "engagement_level": "high"
  },
  "performance_metrics": {
    "conversion_rate": 12.5,
    "avg_order_value": 299.99,
    "lifetime_value": 1500.00
  }
}
```

### `topics` (jsonb)
Content topics and interests associated with the segment.

**Structure:**
```json
{
  "primary_interests": ["marketing automation", "data analytics", "lead generation"],
  "secondary_interests": ["business intelligence", "customer retention"],
  "content_preferences": {
    "format": ["blog_posts", "webinars", "case_studies"],
    "frequency": "weekly",
    "length": "medium"
  }
}
```

### `icp` (jsonb)
Ideal Customer Profile data for the segment.

**Structure:**
```json
{
  "company_size": "11-50",
  "industry": ["technology", "saas"],
  "revenue_range": "1M-10M",
  "decision_makers": ["ceo", "cmo", "marketing_director"],
  "pain_points": ["lead qualification", "marketing attribution"],
  "budget_range": "10000-50000",
  "technology_stack": ["salesforce", "hubspot", "google_analytics"]
}
```

### `rules` (jsonb)
Segmentation rules and criteria.

**Default:** `[]`

**Structure:**
```json
[
  {
    "field": "company_size",
    "operator": "equals",
    "value": "11-50"
  },
  {
    "field": "industry",
    "operator": "in",
    "value": ["technology", "saas"]
  },
  {
    "field": "annual_revenue",
    "operator": "between",
    "value": [1000000, 10000000]
  }
]
```

---

## Settings JSONb Fields

### `products` (jsonb)
Product catalog and pricing information.

**Default:** `[]`

**Structure:**
```json
[
  {
    "id": "product_1",
    "name": "Marketing Automation Platform",
    "description": "Complete marketing automation solution",
    "cost": 50.00,
    "lowest_sale_price": 99.99,
    "target_sale_price": 149.99,
    "category": "software",
    "features": ["email_marketing", "lead_scoring", "analytics"]
  }
]
```

### `services` (jsonb)
Service offerings and pricing.

**Default:** `[]`

**Structure:**
```json
[
  {
    "id": "service_1",
    "name": "Marketing Consultation",
    "description": "Expert marketing strategy consultation",
    "cost": 100.00,
    "lowest_sale_price": 200.00,
    "target_sale_price": 300.00,
    "duration": "1 hour",
    "delivery_method": "video_call"
  }
]
```

### `swot` (jsonb)
SWOT analysis for the business.

**Default:** `{"threats": "", "strengths": "", "weaknesses": "", "opportunities": ""}`

**Structure:**
```json
{
  "strengths": "Strong technical team, proven track record",
  "weaknesses": "Limited marketing budget, small sales team",
  "opportunities": "Growing market demand, new technology trends",
  "threats": "Increased competition, economic uncertainty"
}
```

### `locations` (jsonb)
Business locations and office information.

**Default:** `[]`

**Structure:**
```json
[
  {
    "id": "location_1",
    "name": "Headquarters",
    "address": "123 Business Ave",
    "city": "New York",
    "state": "NY",
    "zip": "10001",
    "country": "USA",
    "type": "office",
    "coordinates": {
      "lat": 40.7128,
      "lng": -74.0060
    }
  }
]
```

### `marketing_budget` (jsonb)
Marketing budget allocation and tracking.

**Default:** `{"total": 0, "available": 0}`

**Structure:**
```json
{
  "total": 100000,
  "available": 75000,
  "currency": "USD",
  "period": "quarterly",
  "allocation": {
    "digital_marketing": 40000,
    "content_creation": 20000,
    "events": 15000,
    "tools": 10000,
    "other": 15000
  }
}
```

### `marketing_channels` (jsonb)
Marketing channel configuration and performance.

**Default:** `[]`

**Structure:**
```json
[
  {
    "channel": "email",
    "enabled": true,
    "budget_allocation": 25000,
    "performance": {
      "open_rate": 24.5,
      "click_rate": 3.2,
      "conversion_rate": 2.1
    }
  },
  {
    "channel": "social_media",
    "enabled": true,
    "platforms": ["linkedin", "twitter", "facebook"],
    "budget_allocation": 30000
  }
]
```

### `social_media` (jsonb)
Social media profiles and settings.

**Default:** `[]`

**Structure:**
```json
[
  {
    "platform": "linkedin",
    "url": "https://linkedin.com/company/example",
    "handle": "@company",
    "enabled": true,
    "follower_count": 5000
  },
  {
    "platform": "twitter",
    "url": "https://twitter.com/company",
    "handle": "@company",
    "enabled": true,
    "follower_count": 3000
  }
]
```

### `team_members` (jsonb)
Team member information and roles.

**Default:** `[]`

**Structure:**
```json
[
  {
    "id": "member_1",
    "name": "John Doe",
    "email": "john@company.com",
    "role": "Marketing Manager",
    "department": "Marketing",
    "hire_date": "2024-01-15",
    "permissions": ["campaigns", "leads", "analytics"]
  }
]
```

### `team_roles` (jsonb)
Team role definitions and permissions.

**Default:** `[]`

**Structure:**
```json
[
  {
    "name": "Marketing Manager",
    "description": "Manages marketing campaigns and strategies",
    "permissions": ["campaigns", "leads", "analytics", "content"],
    "level": "manager"
  }
]
```

### `org_structure` (jsonb)
Organizational structure and hierarchy.

**Default:** `{}`

**Structure:**
```json
{
  "departments": [
    {
      "name": "Marketing",
      "head": "john@company.com",
      "members": ["jane@company.com", "bob@company.com"]
    }
  ],
  "reporting_structure": {
    "ceo": "ceo@company.com",
    "direct_reports": ["cmo@company.com", "cto@company.com"]
  }
}
```

### `competitors` (jsonb)
Competitor information and analysis.

**Default:** `[]`

**Structure:**
```json
[
  {
    "name": "Competitor 1",
    "url": "https://competitor1.com",
    "industry": "technology",
    "size": "enterprise",
    "strengths": ["brand_recognition", "large_budget"],
    "weaknesses": ["slow_innovation", "poor_customer_service"]
  }
]
```

### `goals` (jsonb)
Business goals and objectives.

**Default:** `[]`

**Structure:**
```json
{
  "quarterly": "Increase lead generation by 25%",
  "yearly": "Achieve $1M ARR",
  "fiveYear": "Become market leader in segment",
  "tenYear": "Global expansion and IPO"
}
```

### `channels` (jsonb)
Communication channel configurations.

**Default:** `[]`

**Structure:**
```json
{
  "email": {
    "enabled": true,
    "email": "support@company.com",
    "password": "encrypted_password",
    "aliases": "noreply@company.com, hello@company.com, info@company.com",
    "incomingServer": "imap.company.com",
    "incomingPort": "993",
    "outgoingServer": "smtp.company.com",
    "outgoingPort": "587",
    "status": "active"
  },
  "whatsapp": {
    "enabled": true,
    "setupType": "new_number",
    "country": "US",
    "region": "CA",
    "number": "+1234567890",
    "apiToken": "encrypted_token",
    "account_sid": "account_sid",
    "status": "active"
  }
}
```

### `business_hours` (jsonb)
Company business hours.

**Default:** `{}`

**Structure:**
```json
{
  "timezone": "America/New_York",
  "days": {
    "monday": {"open": "09:00", "close": "17:00"},
    "tuesday": {"open": "09:00", "close": "17:00"},
    "wednesday": {"open": "09:00", "close": "17:00"},
    "thursday": {"open": "09:00", "close": "17:00"},
    "friday": {"open": "09:00", "close": "17:00"},
    "saturday": {"closed": true},
    "sunday": {"closed": true}
  }
}
```

### `branding` (jsonb)
Brand identity and design system information.

**Default:** `NULL`

**Structure:**
```json
{
  "brand_pyramid": {
    "brand_essence": "Core brand essence - who we are",
    "brand_personality": "Confident, innovative, and approachable",
    "brand_benefits": "Peace of mind, increased efficiency, better results",
    "brand_attributes": "24/7 support, advanced analytics, user-friendly interface",
    "brand_values": "Innovation, transparency, customer-centricity",
    "brand_promise": "We promise to deliver exceptional value and results"
  },
  "brand_archetype": "hero",
  "color_palette": {
    "primary_color": "#000000",
    "secondary_color": "#666666",
    "accent_color": "#e0ff17",
    "success_color": "#22c55e",
    "warning_color": "#f59e0b",
    "error_color": "#ef4444",
    "background_color": "#ffffff",
    "surface_color": "#f8fafc"
  },
  "typography": {
    "primary_font": "Inter, sans-serif",
    "secondary_font": "Georgia, serif",
    "font_size_scale": "medium"
  },
  "voice_and_tone": {
    "communication_style": "friendly",
    "personality_traits": ["innovative", "trustworthy", "approachable"],
    "forbidden_words": ["cheap", "basic", "simple"],
    "preferred_phrases": ["premium quality", "customer-focused", "cutting-edge"]
  },
  "brand_guidelines": {
    "do_list": ["Always be transparent", "Focus on customer benefits", "Use clear language"],
    "dont_list": ["Never compromise on quality", "Don't use jargon", "Avoid being pushy"],
    "emotions_to_evoke": ["trust", "excitement", "confidence"]
  },
  "brand_assets": {
    "logo_variations": [
      {
        "name": "Primary Logo",
        "url": "https://example.com/logo-primary.png",
        "usage": "Main brand applications and light backgrounds"
      },
      {
        "name": "Dark Logo",
        "url": "https://example.com/logo-dark.png",
        "usage": "Dark backgrounds and high contrast applications"
      },
      {
        "name": "Icon",
        "url": "https://example.com/logo-icon.png",
        "usage": "Social media profiles and small applications"
      }
    ]
  }
}
```

### `customer_journey` (jsonb)
Customer journey configuration with metrics, actions, and tactics for each stage.

**Default:** `{"awareness": {"metrics": [], "actions": [], "tactics": []}, "consideration": {"metrics": [], "actions": [], "tactics": []}, "decision": {"metrics": [], "actions": [], "tactics": []}, "purchase": {"metrics": [], "actions": [], "tactics": []}, "retention": {"metrics": [], "actions": [], "tactics": []}, "referral": {"metrics": [], "actions": [], "tactics": []}}`

**Structure:**
```json
{
  "awareness": {
    "metrics": ["Website traffic", "Brand mentions", "Impressions", "Social media reach"],
    "actions": ["Content marketing", "SEO optimization", "Social media ads", "PR campaigns"],
    "tactics": ["Blog posts", "Video content", "Infographics", "Influencer partnerships"]
  },
  "consideration": {
    "metrics": ["Product page views", "Demo requests", "Comparison views", "Reviews read"],
    "actions": ["Product demos", "Free trials", "Case studies", "Competitor comparison"],
    "tactics": ["Sales presentations", "ROI calculators", "Customer testimonials", "Feature comparisons"]
  },
  "decision": {
    "metrics": ["Quote requests", "Sales meetings", "Proposal views", "Decision timeline"],
    "actions": ["Sales calls", "Proposal creation", "Contract negotiation", "Decision support"],
    "tactics": ["Personalized proposals", "Pricing options", "Implementation plans", "Risk mitigation"]
  },
  "purchase": {
    "metrics": ["Conversion rate", "Cart abandonment", "Purchase value", "Payment completion"],
    "actions": ["Checkout optimization", "Payment options", "Security badges", "Limited offers"],
    "tactics": ["Discount codes", "Free shipping", "Money-back guarantee", "Multiple payment methods"]
  },
  "retention": {
    "metrics": ["Repeat purchases", "Churn rate", "Usage frequency", "Support tickets"],
    "actions": ["Onboarding", "Customer support", "Product updates", "Loyalty programs"],
    "tactics": ["Welcome series", "Progress tracking", "Feature tutorials", "Reward systems"]
  },
  "referral": {
    "metrics": ["Referrals", "Reviews", "Social shares", "NPS score"],
    "actions": ["Referral programs", "Review requests", "Community building", "VIP experiences"],
    "tactics": ["Referral bonuses", "Ambassador programs", "User-generated content", "Exclusive events"]
  }
}
```

**Usage Notes:**
- Each stage contains three types of data: metrics (what to measure), actions (what to do), and tactics (how to do it)
- Arrays can be empty if no configuration is set for that category
- Users can customize these lists through the Customer Journey settings tab
- This data is used throughout the system to guide marketing automation and analytics

### `press_releases` (jsonb)
Company press releases and news.

**Default:** `[]`

**Structure:**
```json
[
  {
    "title": "Company Announces Major Partnership",
    "date": "2024-01-15",
    "url": "https://company.com/press/partnership",
    "summary": "Brief summary of the press release"
  }
]
```

### `partnerships` (jsonb)
Company partnerships and alliances.

**Default:** `[]`

**Structure:**
```json
[
  {
    "partner_name": "Tech Partner Inc",
    "type": "technology",
    "status": "active",
    "start_date": "2024-01-01",
    "description": "Strategic technology partnership"
  }
]
```

### `competitor_info` (jsonb)
Competitive intelligence and analysis.

**Default:** `{}`

**Structure:**
```json
{
  "main_competitors": ["Competitor A", "Competitor B"],
  "competitive_advantages": ["superior_technology", "better_pricing"],
  "market_position": "challenger",
  "differentiation": "Focus on SMB market with simplified solution"
}
```

### `diversity_info` (jsonb)
Company diversity and inclusion information.

**Default:** `{}`

**Structure:**
```json
{
  "diversity_stats": {
    "gender_breakdown": {
      "male": 60,
      "female": 40
    },
    "leadership_diversity": {
      "male": 70,
      "female": 30
    }
  },
  "initiatives": ["mentorship_program", "diversity_hiring"],
  "certifications": ["diversity_certified"]
}
```

### `office_locations` (jsonb)
Company office locations worldwide.

**Default:** `[]`

**Structure:**
```json
[
  {
    "name": "Headquarters",
    "address": "123 Main St, San Francisco, CA",
    "type": "office",
    "size": "50000 sq ft",
    "employees": 150,
    "primary": true
  },
  {
    "name": "Remote",
    "type": "remote",
    "employees": 25,
    "primary": false
  }
]
```

---

## Conversations JSONb Fields

### `custom_data` (jsonb)
Custom data and metadata for conversations.

**Default:** `{}`

**Structure:**
```json
{
  "conversation_type": "support",
  "priority": "high",
  "category": "technical_issue",
  "tags": ["urgent", "billing", "api"],
  "satisfaction_score": 4.5,
  "resolution_time": 1800,
  "escalated": false,
  "context": {
    "user_agent": "Mozilla/5.0...",
    "page_url": "https://app.company.com/dashboard",
    "referrer": "https://google.com"
  }
}
```

---

## Agents JSONb Fields

### `configuration` (jsonb)
Agent configuration settings and parameters.

**Default:** `{}`

**Structure:**
```json
{
  "model": "gpt-4",
  "temperature": 0.7,
  "max_tokens": 2000,
  "response_format": "conversational",
  "language": "en",
  "personality": "professional",
  "knowledge_base": ["general", "product_specific"],
  "escalation_rules": {
    "keywords": ["refund", "cancel", "manager"],
    "sentiment_threshold": -0.5,
    "response_time_limit": 300
  },
  "triggers": {
    "new_lead": {
      "enabled": true,
      "name": "New Lead Alert",
      "description": "Triggered when a new lead is created"
    },
    "abandoned_cart": {
      "enabled": true,
      "name": "Abandoned Cart Recovery",
      "description": "Triggered when cart is abandoned"
    }
  }
}
```

### `tools` (jsonb)
Available tools and their configurations for the agent.

**Default:** `{}`

**Structure:**
```json
{
  "email_integration": {
    "enabled": true,
    "name": "Email Integration",
    "description": "Send and receive emails"
  },
  "calendar_booking": {
    "enabled": true,
    "name": "Calendar Booking",
    "description": "Schedule appointments and meetings"
  },
  "crm_access": {
    "enabled": true,
    "name": "CRM Access",
    "description": "Access customer relationship management data"
  },
  "knowledge_base": {
    "enabled": true,
    "name": "Knowledge Base",
    "description": "Access company knowledge base"
  }
}
```

### `activities` (jsonb)
Agent activities and their configurations.

**Default:** `{}`

**Structure:**
```json
{
  "lead_qualification": {
    "name": "Lead Qualification",
    "description": "Qualify incoming leads based on criteria",
    "estimatedTime": "5-10 min",
    "successRate": 85,
    "executions": 142,
    "status": "available",
    "enabled": true
  },
  "appointment_booking": {
    "name": "Appointment Booking",
    "description": "Schedule appointments with prospects",
    "estimatedTime": "10-15 min",
    "successRate": 90,
    "executions": 98,
    "status": "available",
    "enabled": true
  }
}
```

### `integrations` (jsonb)
Third-party integrations and their connection status.

**Default:** `{}`

**Structure:**
```json
{
  "slack": {
    "connected": true,
    "name": "Slack",
    "description": "Connect to Slack workspace",
    "api_key": "encrypted_key",
    "webhook_url": "https://hooks.slack.com/..."
  },
  "salesforce": {
    "connected": false,
    "name": "Salesforce",
    "description": "Access Salesforce CRM data",
    "api_key": null,
    "instance_url": null
  },
  "hubspot": {
    "connected": true,
    "name": "HubSpot",
    "description": "Connect to HubSpot CRM",
    "api_key": "encrypted_key",
    "portal_id": "12345678"
  }
}
```

---

## Campaigns JSONb Fields

### `revenue` (jsonb)
Campaign revenue tracking and projections.

**Default:** `{"actual": 0, "currency": "USD", "estimated": 0, "projected": 0}`

**Structure:**
```json
{
  "actual": 15000.00,
  "projected": 25000.00,
  "estimated": 30000.00,
  "currency": "USD",
  "breakdown": {
    "direct_sales": 12000.00,
    "upsells": 3000.00,
    "cross_sells": 0.00
  },
  "monthly_targets": {
    "january": 5000.00,
    "february": 7500.00,
    "march": 12500.00
  }
}
```

### `budget` (jsonb)
Campaign budget allocation and tracking.

**Default:** `{"currency": "USD", "allocated": 0, "remaining": 0}`

**Structure:**
```json
{
  "allocated": 50000.00,
  "remaining": 30000.00,
  "currency": "USD",
  "spent": 20000.00,
  "breakdown": {
    "advertising": 15000.00,
    "content_creation": 3000.00,
    "tools": 2000.00,
    "other": 0.00
  },
  "monthly_allocation": {
    "january": 15000.00,
    "february": 15000.00,
    "march": 20000.00
  }
}
```

### `metadata` (jsonb)
Campaign metadata including payment status and additional information.

**Default:** `{}`

**Structure:**
```json
{
  "payment_status": {
    "status": "pending",
    "amount_paid": 0.00,
    "amount_due": 5000.00,
    "currency": "USD",
    "payment_method": null,
    "stripe_payment_intent_id": null,
    "payment_date": null,
    "invoice_number": null,
    "outsourced": false,
    "outsource_provider": null,
    "outsource_contact": null
  },
  "performance_tracking": {
    "clicks": 0,
    "impressions": 0,
    "conversions": 0,
    "conversion_rate": 0.0,
    "cost_per_acquisition": 0.0
  },
  "timeline": {
    "planned_start": "2024-01-01",
    "actual_start": null,
    "planned_end": "2024-03-31",
    "actual_end": null,
    "milestones": []
  },
  "custom_fields": {},
  "tags": [],
  "external_references": {
    "project_management_url": null,
    "design_files": [],
    "documentation": []
  }
}
```

---

## Requirements JSONb Fields

### `metadata` (jsonb)
Requirement metadata including payment status and additional information.

**Default:** `{}`

**Structure:**
```json
{
  "payment_status": {
    "status": "pending",
    "amount_paid": 0.00,
    "amount_due": 199.00,
    "currency": "USD",
    "payment_method": null,
    "stripe_payment_intent_id": null,
    "payment_date": null,
    "invoice_number": null,
    "outsourced": false,
    "outsource_provider": null,
    "outsource_contact": null,
    "outsource_instructions": null
  },
  "progress_tracking": {
    "completion_percentage": 0,
    "hours_estimated": 0,
    "hours_actual": 0,
    "start_date": null,
    "end_date": null,
    "blocked": false,
    "blocked_reason": null
  },
  "quality_assurance": {
    "reviewed": false,
    "reviewer": null,
    "review_date": null,
    "review_notes": null,
    "approved": false,
    "approval_date": null
  },
  "dependencies": {
    "blocks": [],
    "blocked_by": [],
    "related_requirements": []
  },
  "external_references": {
    "design_files": [],
    "documentation": [],
    "code_repositories": [],
    "test_cases": []
  },
  "custom_fields": {},
  "tags": []
}
```

---

## Companies JSONb Fields

### `address` (jsonb)
Company address information.

**Default:** `{}`

**Structure:**
```json
{
  "zip": "08700",
  "city": "Ciudad de México",
  "state": "CDMX",
  "country": "Mexico",
  "street": "Sur 113-B, Juventino Rosas, Iztacalco",
  "external_number": "2183",
  "internal_number": "B",
  "coordinates": {
    "lat": 19.3900935,
    "lng": -99.10837719999999
  },
  "full_address": "Sur 113-B 2183, Juventino Rosas, Iztacalco, 08700 Ciudad de México, CDMX, Mexico"
}
```

**New fields added:**
- `external_number`: Building/house number (e.g., "2183")
- `internal_number`: Apartment/suite number (e.g., "B", "18")
- `street`: Street name without numbers (replaces deprecated `address1`)

### `social_media` (jsonb)
Company social media profiles.

**Default:** `{}`

**Structure:**
```json
{
  "linkedin": "https://linkedin.com/company/example",
  "twitter": "https://twitter.com/example",
  "facebook": "https://facebook.com/example",
  "instagram": "https://instagram.com/example",
  "youtube": "https://youtube.com/c/example"
}
```

### `key_people` (jsonb)
Key personnel information.

**Default:** `[]`

**Structure:**
```json
[
  {
    "name": "John Smith",
    "title": "CEO",
    "linkedin": "https://linkedin.com/in/johnsmith",
    "bio": "Experienced technology executive",
    "tenure": "5 years"
  },
  {
    "name": "Jane Doe",
    "title": "CTO",
    "linkedin": "https://linkedin.com/in/janedoe",
    "bio": "Expert in software architecture",
    "tenure": "3 years"
  }
]
```

### `funding_info` (jsonb)
Company funding and investment information.

**Default:** `{}`

**Structure:**
```json
{
  "total_funding": 10000000,
  "currency": "USD",
  "last_round": {
    "type": "Series A",
    "amount": 5000000,
    "date": "2024-01-15",
    "investors": ["Venture Capital Firm", "Angel Investor"]
  },
  "rounds": [
    {
      "type": "Seed",
      "amount": 500000,
      "date": "2023-01-15",
      "investors": ["Seed Fund"]
    }
  ]
}
```

### `products_services` (jsonb)
Company products and services.

**Default:** `[]`

**Structure:**
```json
[
  {
    "name": "Product A",
    "description": "Advanced analytics platform",
    "category": "software",
    "pricing": {
      "model": "subscription",
      "starting_price": 99.99,
      "currency": "USD"
    }
  }
]
```

### `business_hours` (jsonb)
Company business hours.

**Default:** `{}`

**Structure:**
```json
{
  "timezone": "America/New_York",
  "days": {
    "monday": {"open": "09:00", "close": "17:00"},
    "tuesday": {"open": "09:00", "close": "17:00"},
    "wednesday": {"open": "09:00", "close": "17:00"},
    "thursday": {"open": "09:00", "close": "17:00"},
    "friday": {"open": "09:00", "close": "17:00"},
    "saturday": {"closed": true},
    "sunday": {"closed": true}
  }
}
```

### `press_releases` (jsonb)
Company press releases and news.

**Default:** `[]`

**Structure:**
```json
[
  {
    "title": "Company Announces Major Partnership",
    "date": "2024-01-15",
    "url": "https://company.com/press/partnership",
    "summary": "Brief summary of the press release"
  }
]
```

### `partnerships` (jsonb)
Company partnerships and alliances.

**Default:** `[]`

**Structure:**
```json
[
  {
    "partner_name": "Tech Partner Inc",
    "type": "technology",
    "status": "active",
    "start_date": "2024-01-01",
    "description": "Strategic technology partnership"
  }
]
```

### `competitor_info` (jsonb)
Competitive intelligence and analysis.

**Default:** `{}`

**Structure:**
```json
{
  "main_competitors": ["Competitor A", "Competitor B"],
  "competitive_advantages": ["superior_technology", "better_pricing"],
  "market_position": "challenger",
  "differentiation": "Focus on SMB market with simplified solution"
}
```

### `diversity_info` (jsonb)
Company diversity and inclusion information.

**Default:** `{}`

**Structure:**
```json
{
  "diversity_stats": {
    "gender_breakdown": {
      "male": 60,
      "female": 40
    },
    "leadership_diversity": {
      "male": 70,
      "female": 30
    }
  },
  "initiatives": ["mentorship_program", "diversity_hiring"],
  "certifications": ["diversity_certified"]
}
```

### `office_locations` (jsonb)
Company office locations worldwide.

**Default:** `[]`

**Structure:**
```json
[
  {
    "name": "Headquarters",
    "address": "123 Main St, San Francisco, CA",
    "type": "office",
    "size": "50000 sq ft",
    "employees": 150,
    "primary": true
  },
  {
    "name": "Remote",
    "type": "remote",
    "employees": 25,
    "primary": false
  }
]
```

---

## Sales JSONb Fields

### `payment_details` (jsonb)
Payment information for the sale.

**Default:** `{}`

**Structure:**
```json
{
  "payment_method": "credit_card",
  "card_type": "visa",
  "last_four": "1234",
  "transaction_id": "txn_123456789",
  "processor": "stripe",
  "processing_fee": 2.99,
  "net_amount": 297.00
}
```

### `product_details` (jsonb)
Detailed product information for the sale.

**Default:** `{}`

**Structure:**
```json
{
  "product_id": "prod_123",
  "sku": "MKT-PRO-001",
  "variant": "professional",
  "quantity": 1,
  "unit_price": 299.99,
  "discount": 0.00,
  "tax": 24.00,
  "features": ["advanced_analytics", "unlimited_users", "priority_support"]
}
```

### `payments` (jsonb)
Payment installments and history.

**Default:** `[]`

**Structure:**
```json
[
  {
    "date": "2024-01-15",
    "amount": 299.99,
    "method": "credit_card",
    "status": "completed",
    "transaction_id": "txn_123456789"
  },
  {
    "date": "2024-02-15",
    "amount": 299.99,
    "method": "credit_card",
    "status": "scheduled",
    "transaction_id": null
  }
]
```

---

## Visitor Sessions JSONb Fields

> **Nota importante:** Los campos `device`, `browser` y `location` se almacenan únicamente en la tabla `visitor_sessions`, no en la tabla `visitors`. Esto permite rastrear cambios de dispositivo, navegador y ubicación a lo largo de múltiples sesiones del mismo visitante.

### `device` (jsonb)
**Tabla:** `visitor_sessions` únicamente
**Descripción:** Información del dispositivo para la sesión específica del visitante. Se detecta automáticamente desde el User-Agent y se enriquece con datos del cliente.

**Detección automática desde IP:** No aplicable
**Detección automática desde User-Agent:** ✅ Sí

**Estructura:**
```json
{
  "type": "desktop|mobile|tablet",
  "screen_size": "1920x1080",
  "os": {
    "name": "macOS|Windows|Linux|Android|iOS",
    "version": "14.0"
  },
  "touch_support": false
}
```

**Campos obligatorios:**
- `type`: Tipo de dispositivo detectado automáticamente

**Campos opcionales:**
- `screen_size`: Resolución de pantalla si está disponible
- `os`: Sistema operativo y versión
- `touch_support`: Soporte táctil (inferido del tipo de dispositivo)

### `browser` (jsonb)
**Tabla:** `visitor_sessions` únicamente
**Descripción:** Información del navegador para la sesión específica. Se detecta automáticamente desde el User-Agent y headers HTTP.

**Detección automática desde User-Agent:** ✅ Sí
**Detección automática desde Headers:** ✅ Sí (idioma)

**Estructura:**
```json
{
  "name": "Chrome|Firefox|Safari|Edge|Opera",
  "version": "119.0.6045.105",
  "language": "es-ES"
}
```

**Campos obligatorios:**
- `name`: Nombre del navegador detectado automáticamente

**Campos opcionales:**
- `version`: Versión del navegador
- `language`: Idioma preferido extraído de Accept-Language

### `location` (jsonb)
**Tabla:** `visitor_sessions` únicamente
**Descripción:** Información de geolocalización basada en la IP del visitante. Se obtiene automáticamente usando el servicio ipapi.co.

**Detección automática desde IP:** ✅ Sí (usando ipapi.co)
**Timeout:** 3 segundos máximo
**IPs excluidas:** Locales (127.0.0.1, 192.168.x.x, 10.x.x.x, 172.x.x.x)

**Estructura:**
```json
{
  "country": "Spain",
  "region": "Madrid",
  "city": "Madrid"
}
```

**Campos opcionales:**
- `country`: País detectado por IP
- `region`: Región/Estado detectado por IP  
- `city`: Ciudad detectada por IP

**Notas técnicas:**
- Si la IP es local o el servicio falla, los campos quedan vacíos
- No bloquea la respuesta gracias al timeout de 3s
- Se actualiza en cada nueva sesión, permitiendo rastrear movimiento geográfico

### `performance` (jsonb)
Performance and loading metrics.

**Structure:**
```json
{
  "page_load_time": 2.5,
  "dom_content_loaded": 1.8,
  "first_paint": 1.2,
  "first_contentful_paint": 1.5,
  "largest_contentful_paint": 2.1,
  "cumulative_layout_shift": 0.05,
  "connection_type": "4g"
}
```

### `consent` (jsonb)
User consent and privacy preferences.

**Structure:**
```json
{
  "analytics": true,
  "marketing": false,
  "functional": true,
  "timestamp": "2024-01-15T10:30:00Z",
  "method": "banner",
  "version": "1.0"
}
```

### `custom_data` (jsonb)
Custom tracking data and attributes.

**Structure:**
```json
{
  "experiment_id": "exp_123",
  "variant": "control",
  "custom_attributes": {
    "user_type": "returning",
    "source": "email_campaign"
  }
}
```

### `lead_data` (jsonb)
Lead identification and qualification data.

**Structure:**
```json
{
  "identified_at": "2024-01-15T10:45:00Z",
  "identification_method": "form_submission",
  "score": 75,
  "qualification_status": "qualified",
  "interests": ["marketing", "automation"]
}
```

---

## Session Events JSONb Fields

### `data` (jsonb)
Event-specific data and parameters.

**Structure:**
```json
{
  "element_id": "signup_button",
  "element_class": "btn btn-primary",
  "element_text": "Sign Up Now",
  "page_title": "Pricing - Marketing Platform",
  "scroll_depth": 75,
  "time_on_page": 120,
  "form_data": {
    "field_name": "email",
    "field_value": "user@example.com"
  }
}
```

### `properties` (jsonb)
Event properties and metadata.

**Default:** `{}`

**Structure:**
```json
{
  "event_category": "user_interaction",
  "event_action": "click",
  "event_label": "pricing_page_signup",
  "value": 1,
  "custom_properties": {
    "experiment_id": "exp_123",
    "variant": "control"
  }
}
```

### `activity` (jsonb)
User activity and engagement data.

**Structure:**
```json
{
  "session_duration": 300,
  "page_views": 5,
  "interactions": 12,
  "scroll_events": 8,
  "click_events": 4,
  "form_submissions": 1,
  "downloads": 0,
  "video_plays": 0
}
```

---

## Commands JSONb Fields

### `results` (jsonb)
Command execution results and outputs.

**Default:** `[]`

**Structure:**
```json
[
  {
    "step": 1,
    "action": "data_analysis",
    "status": "completed",
    "output": "Analyzed 1,000 leads, found 85% match criteria",
    "timestamp": "2024-01-15T10:30:00Z",
    "duration": 30
  },
  {
    "step": 2,
    "action": "email_campaign",
    "status": "completed",
    "output": "Sent 850 emails, 24% open rate",
    "timestamp": "2024-01-15T10:32:00Z",
    "duration": 120
  }
]
```

### `targets` (jsonb)
Command targets and objectives.

**Default:** `[]`

**Structure:**
```json
[
  {
    "type": "lead_generation",
    "quantity": 100,
    "quality_score": 80,
    "timeframe": "1 week",
    "criteria": {
      "industry": "technology",
      "company_size": "11-50"
    }
  }
]
```

### `tools` (jsonb)
Tools and resources used by the command.

**Default:** `[]`

**Structure:**
```json
[
  {
    "name": "email_sender",
    "version": "1.0",
    "configuration": {
      "smtp_server": "smtp.company.com",
      "port": 587,
      "encryption": "tls"
    }
  },
  {
    "name": "data_analyzer",
    "version": "2.1",
    "configuration": {
      "algorithm": "machine_learning",
      "model": "classification"
    }
  }
]
```

### `supervisor` (jsonb)
Supervisor and oversight information.

**Default:** `[]`

**Structure:**
```json
[
  {
    "agent_id": "agent_123",
    "role": "quality_assurance",
    "checkpoints": ["25%", "50%", "75%", "100%"],
    "approval_required": true
  }
]
```

### `functions` (jsonb)
Available functions and capabilities.

**Default:** `[]`

**Structure:**
```json
[
  {
    "name": "send_email",
    "description": "Send personalized emails to leads",
    "parameters": {
      "recipient": "string",
      "subject": "string",
      "body": "string",
      "template": "string"
    }
  },
  {
    "name": "analyze_data",
    "description": "Analyze lead data and provide insights",
    "parameters": {
      "dataset": "string",
      "analysis_type": "string"
    }
  }
]
```

---

## Profiles JSONb Fields

### `notifications` (jsonb)
User notification preferences.

**Default:** `{"push": true, "email": true}`

**Structure:**
```json
{
  "push": true,
  "email": true,
  "sms": false,
  "in_app": true,
  "frequency": "daily",
  "categories": {
    "marketing": true,
    "system": true,
    "security": true,
    "billing": false
  }
}
```

### `settings` (jsonb)
User preferences and settings.

**Default:** `{}`

**Structure:**
```json
{
  "theme": "dark",
  "date_format": "MM/DD/YYYY",
  "time_format": "12h",
  "dashboard_layout": "compact",
  "auto_save": true,
  "keyboard_shortcuts": true,
  "privacy": {
    "profile_visibility": "public",
    "activity_visibility": "private"
  }
}
```

### `metadata` (jsonb)
User metadata and custom attributes.

**Default:** `{}`

**Structure:**
```json
{
  "onboarding_completed": true,
  "feature_flags": {
    "beta_features": true,
    "advanced_analytics": false
  },
  "usage_stats": {
    "login_count": 150,
    "last_login": "2024-01-15T10:30:00Z",
    "favorite_features": ["campaigns", "analytics"]
  }
}
```

---

## Sites JSONb Fields

### `resource_urls` (jsonb)
Site resource URLs and assets.

**Default:** `[]`

**Structure:**
```json
[
  {
    "type": "css",
    "url": "https://cdn.example.com/styles.css",
    "version": "1.0",
    "integrity": "sha256-abc123"
  },
  {
    "type": "javascript",
    "url": "https://cdn.example.com/app.js",
    "version": "2.1",
    "integrity": "sha256-def456"
  },
  {
    "type": "font",
    "url": "https://fonts.googleapis.com/css2?family=Inter",
    "version": "1.0"
  }
]
```

### `tracking` (jsonb)
Site tracking and analytics configuration.

**Default:** `{"record_screen": false, "track_actions": false, "track_visitors": false}`

**Structure:**
```json
{
  "track_visitors": true,
  "track_actions": true,
  "record_screen": false,
  "enable_chat": true,
  "chat_accent_color": "#e0ff17",
  "allow_anonymous_messages": false,
  "chat_position": "bottom-right",
  "welcome_message": "Welcome to our website! How can we assist you today?",
  "chat_title": "Chat with us",
  "analytics_provider": "google_analytics",
  "analytics_id": "GA-123456789",
  "tracking_code": "<script>...</script>",
  "privacy": {
    "cookie_consent": true,
    "gdpr_compliant": true,
    "data_retention_days": 365
  }
}
```

---

## Task Comments JSONb Fields

### `attachments` (jsonb)
Legacy attachment data for task comments.

**Default:** `[]`

**Structure:**
```json
[
  {
    "name": "document.pdf",
    "url": "https://storage.example.com/files/document.pdf",
    "size": 1024000,
    "type": "application/pdf",
    "uploaded_at": "2024-01-15T10:30:00Z"
  }
]
```

### `files` (jsonb)
File attachments with metadata for task comments.

**Default:** `[]`

**Structure:**
```json
[
  {
    "name": "screenshot.png",
    "url": "https://storage.supabase.co/object/public/task_files/task-id/timestamp.png",
    "size": 245760,
    "type": "image/png"
  },
  {
    "name": "report.pdf",
    "url": "https://storage.supabase.co/object/public/task_files/task-id/timestamp.pdf",
    "size": 1024000,
    "type": "application/pdf"
  }
]
```

**Properties:**
- `name`: Original filename
- `url`: Public URL to the stored file
- `size`: File size in bytes
- `type`: MIME type of the file

### `cta` (jsonb)
Call-to-Action button data for task comments.

**Default:** `null`

**Structure:**
```json
{
  "primary_action": {
    "title": "View Details",
    "url": "https://example.com/task-details"
  }
}
```

**Properties:**
- `primary_action.title`: Button text displayed to users (e.g., "Download File", "View Demo")
- `primary_action.url`: Target URL that opens in a new tab

**Usage Examples:**
```json
{
  "primary_action": {
    "title": "Download Report",
    "url": "https://storage.example.com/reports/monthly-report.pdf"
  }
}
```
```json
{
  "primary_action": {
    "title": "View Demo",
    "url": "https://demo.example.com/feature-walkthrough"
  }
}
```

**Validation Rules:**
- Both `title` and `url` must be provided for the CTA to be displayed
- If either field is empty or missing, the CTA will be `null`
- URLs should be properly formatted and accessible
- Button text should be concise and actionable (recommended: 1-3 words)

**Frontend Implementation:**
- CTA buttons appear below comment content and file attachments
- Buttons open links in new tabs with security attributes (`target="_blank" rel="noopener noreferrer"`)
- Styled as primary buttons with external link icon
- Only displayed when both title and url are present
- **Automatic URL Detection**: URLs in comment text are automatically detected and suggested as CTA
  - Supports `https://`, `http://`, and `www.` URLs
  - Auto-generates meaningful button text from URL path or domain
  - Shows "Auto-detected" badge when URL is found automatically
  - User can edit the suggested title and URL before saving

---

## Other JSONb Fields

### `analysis.structure` (jsonb)
Page structure analysis data.

**Structure:**
```json
{
  "elements": {
    "headings": ["H1", "H2", "H3"],
    "images": 15,
    "links": 42,
    "forms": 2
  },
  "seo": {
    "title_length": 65,
    "meta_description_length": 155,
    "h1_count": 1,
    "alt_text_missing": 3
  },
  "performance": {
    "page_size": "2.5MB",
    "load_time": "3.2s",
    "lighthouse_score": 85
  }
}
```

### `api_keys.metadata` (jsonb)
API key metadata and configuration.

**Default:** `{}`

**Structure:**
```json
{
  "description": "Marketing automation API key",
  "rate_limit": 1000,
  "allowed_ips": ["192.168.1.0/24"],
  "webhook_endpoints": ["https://api.company.com/webhook"],
  "features": ["read", "write", "delete"],
  "environment": "production"
}
```

### `content.metadata` (jsonb)
Content metadata and SEO information.

**Default:** `{}`

**Structure:**
```json
{
  "seo": {
    "meta_title": "How to Improve Marketing ROI",
    "meta_description": "Learn proven strategies to improve your marketing ROI",
    "keywords": ["marketing", "roi", "strategy"],
    "canonical_url": "https://company.com/blog/improve-marketing-roi"
  },
  "social": {
    "og_title": "How to Improve Marketing ROI",
    "og_description": "Learn proven strategies to improve your marketing ROI",
    "og_image": "https://company.com/images/marketing-roi.jpg",
    "twitter_card": "summary_large_image"
  },
  "content_structure": {
    "reading_level": "intermediate",
    "content_type": "how_to",
    "industry": "marketing"
  }
}
```

### `debug_logs.details` (jsonb)
Debug logging details and context.

**Structure:**
```json
{
  "operation_type": "lead_import",
  "input_data": {
    "file_name": "leads.csv",
    "row_count": 1000
  },
  "processing_steps": [
    {
      "step": "validation",
      "status": "success",
      "processed": 1000,
      "errors": 0
    },
    {
      "step": "import",
      "status": "partial_success",
      "processed": 950,
      "errors": 50
    }
  ],
  "error_details": [
    {
      "row": 25,
      "field": "email",
      "error": "invalid_format",
      "value": "not-an-email"
    }
  ]
}
```

### `payments.details` (jsonb)
Payment transaction details.

**Default:** `{}`

**Structure:**
```json
{
  "stripe_payment_intent": "pi_123456789",
  "payment_method": {
    "type": "card",
    "card": {
      "brand": "visa",
      "last4": "1234",
      "exp_month": 12,
      "exp_year": 2025
    }
  },
  "billing_address": {
    "line1": "123 Main St",
    "city": "San Francisco",
    "state": "CA",
    "postal_code": "94105",
    "country": "US"
  },
  "receipt_url": "https://pay.stripe.com/receipts/..."
}
```

### `waitlist.metadata` (jsonb)
Waitlist metadata and user information.

**Default:** `{}`

**Structure:**
```json
{
  "source": "landing_page",
  "campaign": "beta_launch",
  "referrer": "https://producthunt.com",
  "user_agent": "Mozilla/5.0...",
  "interests": ["marketing", "automation"],
  "company": "Startup Inc",
  "role": "Marketing Manager",
  "use_case": "Lead generation automation"
}
```

---

## Usage Guidelines

### Best Practices

1. **Data Validation**: Always validate JSONb data before insertion to ensure proper structure
2. **Indexing**: Use GIN indexes on frequently queried JSONb fields for better performance
3. **Schema Evolution**: Plan for schema changes by using flexible JSONb structures
4. **Documentation**: Keep this documentation updated when adding new fields or changing structures

### Performance Considerations

- Use specific JSON operators (`->`, `->>`, `@>`, etc.) for efficient querying
- Consider creating partial indexes on specific JSONb paths for frequently accessed data
- Monitor JSONb field sizes to avoid storage bloat
- Use `jsonb_set()` and `jsonb_insert()` for updating specific paths within large JSONb objects

### Security Notes

- Sanitize user input before storing in JSONb fields
- Be cautious with storing sensitive data in JSONb fields
- Use proper encryption for sensitive data like API keys and payment information
- Consider data privacy regulations (GDPR, CCPA) when storing personal information

---

*Last updated: 2024-01-15* 