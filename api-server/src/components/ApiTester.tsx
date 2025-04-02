'use client';

import React, { useState } from 'react';
import { UnifiedApiTester } from './ApiTester/UnifiedApiTester';

// Re-export UnifiedApiTester
export { UnifiedApiTester };

const ApiTester: React.FC = () => {
  const [site_id, setSiteId] = useState<string>('');
  const [event_type, setEventType] = useState<string>('');
  const [event_name, setEventName] = useState<string>('');
  const [url, setUrl] = useState<string>('');
  const [referrer, setReferrer] = useState<string>('');
  const [visitor_id, setVisitorId] = useState<string>('');
  const [session_id, setSessionId] = useState<string>('');
  const [properties, setProperties] = useState<string>('{}');
  const [response, setResponse] = useState<any>(null);
  const [endpoint, setEndpoint] = useState<string>('/api/visitors/track');
  const [method, setMethod] = useState<string>('POST');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const data = {
      site_id,
      event_type,
      event_name,
      url,
      referrer,
      visitor_id,
      session_id,
      timestamp: Date.now(),
      properties: JSON.parse(properties)
    };

    try {
      const response = await fetch(endpoint, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-SA-API-KEY': 'your-api-key' // Replace with actual API key
        },
        body: JSON.stringify(data)
      });
      const result = await response.json();
      setResponse(result);
    } catch (error) {
      console.error('Error:', error);
      setResponse({ error: 'Failed to send request' });
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      {/* ... existing form fields ... */}
      <div>
        <label>Properties (JSON):</label>
        <textarea
          value={properties}
          onChange={(e) => setProperties(e.target.value)}
          placeholder='{"events": [], "activity": []}'
        />
      </div>
      <button type="submit">Send Request</button>
      {response && <pre>{JSON.stringify(response, null, 2)}</pre>}
    </form>
  );
};

export default ApiTester; 