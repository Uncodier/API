'use client';

import { useState, useEffect } from 'react';
import { ComposioService } from '@/lib/services/composio-service';

/**
 * Example component that fetches and displays Composio integrations
 */
export default function ComposioIntegrationsExample() {
  const [integrations, setIntegrations] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIntegration, setSelectedIntegration] = useState<any>(null);

  // Fetch integrations on component mount
  useEffect(() => {
    async function fetchIntegrations() {
      try {
        setLoading(true);
        const data = await ComposioService.getIntegrations();
        setIntegrations(data || []);
        setError(null);
      } catch (err: any) {
        setError(err.message || 'Failed to fetch integrations');
        console.error('Error fetching integrations:', err);
      } finally {
        setLoading(false);
      }
    }

    fetchIntegrations();
  }, []);

  // Fetch details for a specific integration
  const fetchIntegrationDetails = async (id: string) => {
    try {
      setLoading(true);
      const data = await ComposioService.getIntegrationById(id);
      setSelectedIntegration(data);
      setError(null);
    } catch (err: any) {
      setError(err.message || `Failed to fetch integration details for ID: ${id}`);
      console.error('Error fetching integration details:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-4">
      <h1 className="text-2xl font-bold mb-4">Composio Integrations</h1>
      
      {error && (
        <div className="p-4 mb-4 text-sm text-red-700 bg-red-100 rounded-lg">
          {error}
        </div>
      )}

      {loading && !selectedIntegration ? (
        <div className="text-center p-4">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 mx-auto"></div>
          <p className="mt-2">Loading integrations...</p>
        </div>
      ) : (
        <>
          {!selectedIntegration ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {integrations.length === 0 ? (
                <p>No integrations found.</p>
              ) : (
                integrations.map((integration) => (
                  <div 
                    key={integration.id} 
                    className="border rounded-lg p-4 cursor-pointer hover:bg-gray-50"
                    onClick={() => fetchIntegrationDetails(integration.id)}
                  >
                    <h2 className="text-lg font-semibold">{integration.name}</h2>
                    <p className="text-sm text-gray-600">{integration.description}</p>
                    <div className="mt-2 text-blue-600 text-sm">Click for details</div>
                  </div>
                ))
              )}
            </div>
          ) : (
            <div className="mt-4">
              <button 
                onClick={() => setSelectedIntegration(null)} 
                className="mb-4 text-blue-600 hover:underline"
              >
                ← Back to all integrations
              </button>
              
              <div className="border rounded-lg p-4">
                <h2 className="text-xl font-bold mb-2">{selectedIntegration.name}</h2>
                <p className="text-gray-700 mb-4">{selectedIntegration.description}</p>
                
                <div className="mt-4">
                  <h3 className="font-semibold mb-2">Integration Details</h3>
                  <pre className="bg-gray-100 p-4 rounded-md overflow-auto">
                    {JSON.stringify(selectedIntegration, null, 2)}
                  </pre>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
} 