import { RegionVenuesService } from '@/services/sales/RegionVenuesService';

export interface SearchRegionVenuesParams {
  searchTerm: string;
  city: string;
  region: string;
  country?: string;
  limit?: number;
  excludeNames?: string[];
}

export const searchRegionVenuesTool = (siteId: string) => {
  return {
    name: 'search_region_venues',
    description: 'Search for local venues, businesses, or places in a specific region using Google Maps. Useful for finding leads, competitors, or specific types of businesses in a city/region.',
    parameters: {
      type: 'object',
      properties: {
        searchTerm: {
          type: 'string',
          description: 'The search term (e.g., "Italian restaurants", "Gyms", "Software companies").',
        },
        city: {
          type: 'string',
          description: 'The city to search in.',
        },
        region: {
          type: 'string',
          description: 'The region, state, or province.',
        },
        country: {
          type: 'string',
          description: 'The country (optional but recommended for accuracy).',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 5).',
        },
        excludeNames: {
          type: 'array',
          items: {
            type: 'string',
          },
          description: 'List of venue names to exclude from results.',
        },
      },
      required: ['searchTerm', 'city', 'region'],
    },
    execute: async (args: SearchRegionVenuesParams) => {
      try {
        console.log(`[SearchRegionVenuesTool] 🔍 Searching venues: "${args.searchTerm}" in ${args.city}, ${args.region}`);
        
        const service = new RegionVenuesService();
        
        const result = await service.searchRegionVenues({
          siteId,
          searchTerm: args.searchTerm,
          city: args.city,
          region: args.region,
          country: args.country,
          limit: args.limit || 5,
          excludeVenues: args.excludeNames ? { names: args.excludeNames } : undefined
        });

        if (!result.success) {
          throw new Error(result.error || 'Failed to search venues');
        }

        const venues = result.venues || [];
        
        if (venues.length === 0) {
          return {
            success: true,
            result: 'No venues found matching the criteria.',
            venues: []
          };
        }

        // Format the result for the assistant
        const formattedResult = venues.map(v => 
          `Name: ${v.name}\nAddress: ${v.address}\nPhone: ${v.phone}\nWebsite: ${v.website}\nRating: ${v.rating} (${v.total_ratings} reviews)\nTypes: ${v.types.join(', ')}\nDescription: ${v.description}`
        ).join('\n\n---\n\n');

        return {
          success: true,
          result: `Found ${venues.length} venues:\n\n${formattedResult}`,
          venues: venues
        };
      } catch (error: any) {
        console.error(`[SearchRegionVenuesTool] ❌ Error searching venues:`, error);
        throw error;
      }
    },
  };
};
