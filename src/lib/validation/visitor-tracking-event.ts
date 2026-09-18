import { z } from 'zod';

const baseEventSchema = z.object({
  site_id: z.string(),
  url: z.string().url(),
  referrer: z.string().url().optional(),
  id: z.string().uuid().optional(),
  visitor_id: z.string().uuid().optional(),
  session_id: z.string().uuid().optional(),
  segment_id: z.string().uuid().optional(),
  timestamp: z.number().optional(),
  user_agent: z.string().optional(),
  ip: z.string().optional(),
  properties: z.record(z.any()).optional(),
});

const clickEventSchema = baseEventSchema.extend({
  event_type: z.literal('click'),
  properties: z.object({
    x: z.number().optional(),
    y: z.number().optional(),
    element: z.object({
      tag: z.string().optional(),
      class: z.string().optional(),
      id: z.string().optional(),
      text: z.string().optional(),
    }).optional(),
  }).optional(),
});

const customEventSchema = baseEventSchema.extend({
  event_type: z.literal('custom'),
  event_name: z.string(),
  properties: z.record(z.any()).optional(),
});

const purchaseEventSchema = baseEventSchema.extend({
  event_type: z.literal('purchase'),
  properties: z.object({
    order_id: z.string(),
    total_amount: z.number(),
    currency: z.string(),
    payment_method: z.string(),
    items: z.array(z.object({
      product_id: z.string(),
      product_name: z.string(),
      price: z.number(),
      quantity: z.number(),
    })),
  }),
});

const actionEventSchema = baseEventSchema.extend({
  event_type: z.literal('action'),
  event_name: z.string(),
  properties: z.record(z.any()).optional(),
});

const mouseMoveEventSchema = baseEventSchema.extend({
  event_type: z.literal('mousemove'),
  properties: z.object({
    x: z.number(),
    y: z.number(),
    viewport: z.object({
      width: z.number(),
      height: z.number(),
    }).optional(),
    element: z.object({
      tag: z.string().optional(),
      class: z.string().optional(),
      id: z.string().optional(),
      text: z.string().optional(),
    }).optional(),
  }),
});

const scrollEventSchema = baseEventSchema.extend({
  event_type: z.literal('scroll'),
  properties: z.object({
    scroll_x: z.number(),
    scroll_y: z.number(),
    max_scroll: z.number(),
    viewport_height: z.number(),
    document_height: z.number(),
    percentage_scrolled: z.number(),
  }),
});

const keyPressEventSchema = baseEventSchema.extend({
  event_type: z.literal('keypress'),
  properties: z.object({
    key: z.string(),
    key_code: z.number(),
    element: z.object({
      tag: z.string().optional(),
      type: z.string().optional(),
      name: z.string().optional(),
    }).optional(),
    is_sensitive: z.boolean().optional(),
  }),
});

const resizeEventSchema = baseEventSchema.extend({
  event_type: z.literal('resize'),
  properties: z.object({
    width: z.number(),
    height: z.number(),
    previous_width: z.number().optional(),
    previous_height: z.number().optional(),
    orientation: z.string().optional(),
  }),
});

const focusEventSchema = baseEventSchema.extend({
  event_type: z.literal('focus'),
  properties: z.object({
    element: z.object({
      tag: z.string().optional(),
      type: z.string().optional(),
      name: z.string().optional(),
      placeholder: z.string().optional(),
    }).optional(),
    focus_duration: z.number().optional(),
  }),
});

const formEventSchema = baseEventSchema.extend({
  event_type: z.enum(['form_submit', 'form_change', 'form_error']),
  properties: z.object({
    form_id: z.string(),
    form_name: z.string(),
    fields: z.array(z.object({
      name: z.string(),
      type: z.string(),
      filled: z.boolean(),
    })).optional(),
    completion_time: z.number().optional(),
    success: z.boolean().optional(),
  }),
});

const performanceEventSchema = baseEventSchema.extend({
  event_type: z.literal('performance'),
  properties: z.object({
    navigation: z.object({
      load_time: z.number(),
      dom_content_loaded: z.number(),
      first_paint: z.number(),
      first_contentful_paint: z.number(),
    }).optional(),
    resources: z.object({
      total: z.number(),
      images: z.number(),
      scripts: z.number(),
      stylesheets: z.number(),
      fonts: z.number(),
    }).optional(),
    memory: z.object({
      used: z.number(),
      total: z.number(),
    }).optional(),
  }),
});

const errorEventSchema = baseEventSchema.extend({
  event_type: z.literal('error'),
  properties: z.object({
    error_type: z.string(),
    message: z.string(),
    stack: z.string().optional(),
    filename: z.string().optional(),
    line_number: z.number().optional(),
    column_number: z.number().optional(),
    browser: z.string().optional(),
    browser_version: z.string().optional(),
  }),
});

export const visitorTrackingEventSchema = z.discriminatedUnion('event_type', [
  baseEventSchema.extend({ event_type: z.literal('pageview') }),
  clickEventSchema,
  customEventSchema,
  purchaseEventSchema,
  actionEventSchema,
  mouseMoveEventSchema,
  scrollEventSchema,
  keyPressEventSchema,
  resizeEventSchema,
  focusEventSchema,
  formEventSchema,
  performanceEventSchema,
  errorEventSchema,
]);

export type VisitorTrackingEvent = z.infer<typeof visitorTrackingEventSchema>;
