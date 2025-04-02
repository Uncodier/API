interface CustomMouseEvent {
  type: string;
  x: number;
  y: number;
  timestamp: number;
}

export default class MouseEventTracker {
  private buffer: CustomMouseEvent[] = [];
  private bufferSize: number = 50; // Maximum number of events to buffer
  private flushInterval: number = 1000; // Flush buffer every 1 second
  private sessionId: string;
  private visitorId: string;
  private siteId: string;
  private url: string;
  private isTracking: boolean = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private activity: CustomMouseEvent[] = []; // New property to store all mouse events

  constructor(sessionId: string, visitorId: string, siteId: string, url: string) {
    this.sessionId = sessionId;
    this.visitorId = visitorId;
    this.siteId = siteId;
    this.url = url;
  }

  public start(): void {
    if (this.isTracking) return;
    this.isTracking = true;
    document.addEventListener('mousemove', this.handleMouseMove.bind(this));
    document.addEventListener('click', this.handleClick.bind(this));
    document.addEventListener('keydown', this.handleKeyPress.bind(this));
    document.addEventListener('scroll', this.handleScroll.bind(this));
    window.addEventListener('resize', this.handleResize.bind(this));
    this.startFlushTimer();
  }

  public stop(): void {
    if (!this.isTracking) return;
    this.isTracking = false;
    document.removeEventListener('mousemove', this.handleMouseMove.bind(this));
    document.removeEventListener('click', this.handleClick.bind(this));
    document.removeEventListener('keydown', this.handleKeyPress.bind(this));
    document.removeEventListener('scroll', this.handleScroll.bind(this));
    window.removeEventListener('resize', this.handleResize.bind(this));
    this.stopFlushTimer();
    this.flushBuffer();
  }

  private handleMouseMove(event: MouseEvent): void {
    const mouseEvent: CustomMouseEvent = {
      type: 'mousemove',
      x: event.clientX,
      y: event.clientY,
      timestamp: Date.now()
    };
    this.buffer.push(mouseEvent);
    this.activity.push(mouseEvent);
    if (this.buffer.length >= this.bufferSize) {
      this.flushBuffer();
    }
  }

  private handleClick(event: MouseEvent): void {
    let targetElement: Element | null = event.target as Element;
    const clickEvent: CustomMouseEvent & { element?: Record<string, string> } = {
      type: 'click',
      x: event.clientX,
      y: event.clientY,
      timestamp: Date.now()
    };
    
    if (targetElement) {
      clickEvent.element = {
        tag: targetElement.tagName.toLowerCase(),
        id: targetElement.id || '',
        class: targetElement.className || '',
        text: targetElement.textContent || ''
      };
    }
    
    this.buffer.push(clickEvent as CustomMouseEvent);
    this.activity.push(clickEvent as CustomMouseEvent);
    if (this.buffer.length >= this.bufferSize) {
      this.flushBuffer();
    }
  }

  private handleKeyPress(event: KeyboardEvent): void {
    // Don't track key presses in password fields or sensitive elements
    if (
      event.target instanceof HTMLInputElement && 
      (event.target.type === 'password' || event.target.dataset.sensitive === 'true')
    ) {
      return;
    }

    let targetElement: Element | null = event.target as Element;
    const keypressEvent: CustomMouseEvent & { 
      key?: string;
      key_code?: number;
      element?: Record<string, string>;
      is_sensitive?: boolean;
    } = {
      type: 'keypress',
      x: 0,
      y: 0,
      timestamp: Date.now(),
      key: event.key,
      key_code: event.keyCode
    };
    
    if (targetElement) {
      keypressEvent.element = {
        tag: targetElement.tagName.toLowerCase(),
        type: targetElement instanceof HTMLInputElement ? targetElement.type : '',
        name: targetElement instanceof HTMLInputElement ? targetElement.name : ''
      };
    }
    
    this.buffer.push(keypressEvent as CustomMouseEvent);
    this.activity.push(keypressEvent as CustomMouseEvent);
    if (this.buffer.length >= this.bufferSize) {
      this.flushBuffer();
    }
  }

  private handleScroll(event: Event): void {
    const scrollEvent: CustomMouseEvent & {
      scroll_x?: number;
      scroll_y?: number;
      percentage_scrolled?: number;
      viewport_height?: number;
      document_height?: number;
    } = {
      type: 'scroll',
      x: window.scrollX,
      y: window.scrollY,
      timestamp: Date.now(),
      scroll_x: window.scrollX,
      scroll_y: window.scrollY,
      viewport_height: window.innerHeight,
      document_height: document.documentElement.scrollHeight,
      percentage_scrolled: Math.round((window.scrollY / (document.documentElement.scrollHeight - window.innerHeight)) * 100)
    };

    this.buffer.push(scrollEvent as CustomMouseEvent);
    this.activity.push(scrollEvent as CustomMouseEvent);
    if (this.buffer.length >= this.bufferSize) {
      this.flushBuffer();
    }
  }

  private handleResize(event: UIEvent): void {
    const resizeEvent: CustomMouseEvent & {
      width?: number;
      height?: number;
      orientation?: string;
    } = {
      type: 'resize',
      x: 0,
      y: 0,
      timestamp: Date.now(),
      width: window.innerWidth,
      height: window.innerHeight,
      orientation: window.innerWidth > window.innerHeight ? 'landscape' : 'portrait'
    };

    this.buffer.push(resizeEvent as CustomMouseEvent);
    this.activity.push(resizeEvent as CustomMouseEvent);
    if (this.buffer.length >= this.bufferSize) {
      this.flushBuffer();
    }
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      this.flushBuffer();
    }, this.flushInterval);
  }

  private stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private flushBuffer(): void {
    if (this.buffer.length === 0) return;

    const events = [...this.buffer];
    this.buffer = [];

    // Send the events to your API
    fetch('/api/visitors/track', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SA-API-KEY': 'your-api-key' // Replace with actual API key
      },
      body: JSON.stringify({
        site_id: this.siteId,
        event_type: 'session_recording',
        url: this.url,
        visitor_id: this.visitorId,
        session_id: this.sessionId,
        timestamp: Date.now(),
        properties: {
          events: events,
          activity: this.activity,
          recording_id: `rec_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
          start_time: this.activity.length > 0 ? Math.min(...this.activity.map(e => e.timestamp)) : Date.now(),
          end_time: Date.now(),
          duration: this.activity.length > 0 ? 
            Date.now() - Math.min(...this.activity.map(e => e.timestamp)) : 0,
          metadata: {
            screen_size: `${window.innerWidth}x${window.innerHeight}`,
            device_type: this.getDeviceType()
          }
        }
      })
    })
    .then(response => response.json())
    .then(data => {
      console.log('Session recording data sent:', data);
    })
    .catch(error => {
      console.error('Error sending session recording data:', error);
    });
  }

  // Helper to determine device type
  private getDeviceType(): string {
    const width = window.innerWidth;
    if (width <= 768) return 'mobile';
    if (width <= 1024) return 'tablet';
    return 'desktop';
  }
} 