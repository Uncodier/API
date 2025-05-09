import { supabaseAdmin } from './supabase-client'

/**
 * Interface for site analysis in the database
 */
export interface DbSiteAnalysis {
  id: string;
  site_id: string;
  url_path: string;
  structure: any;
  user_id: string;
  created_at?: string;
  updated_at?: string;
  status: 'completed' | 'failed' | 'processing';
  request_time: number;
  provider: string;
  model_id: string;
}

/**
 * Interface for creating a new site analysis
 */
export interface CreateSiteAnalysisParams {
  id?: string;
  site_id: string;
  url_path: string;
  structure: any;
  user_id: string;
  status: 'completed' | 'failed' | 'processing';
  request_time: number;
  provider: string;
  model_id: string;
}

/**
 * Check if the analysis table exists
 * @returns true if the table exists
 */
export async function checkSiteAnalysisTableExists(): Promise<boolean> {
  try {
    // Test query to check if the table exists
    const { error } = await supabaseAdmin
      .from('analysis')
      .select('id')
      .limit(1);
    
    if (error) {
      console.error(`Table check error: ${error.message}`);
      // If error code is related to non-existent table/relation
      if (error.code === '42P01' || error.message.includes('does not exist')) {
        return false;
      }
      throw error;
    }
    
    return true;
  } catch (error: any) {
    console.error('Error checking if analysis table exists:', error);
    return false;
  }
}

/**
 * Creates a new site analysis in the database
 * 
 * @param analysisData Analysis data to create
 * @returns The created analysis or null if there was an error
 */
export async function createSiteAnalysis(analysisData: CreateSiteAnalysisParams): Promise<DbSiteAnalysis | null> {
  try {
    // First check if the table exists
    const tableExists = await checkSiteAnalysisTableExists();
    
    if (!tableExists) {
      console.error('analysis table does not exist in the database');
      throw new Error('analysis table does not exist in the database. Please check your database setup.');
    }

    // Log the data we're trying to insert (without large content)
    const logData = {
      ...analysisData,
      structure: '... content omitted ...'
    };
    console.log('Attempting to insert analysis data:', JSON.stringify(logData));
    
    const { data, error, status, statusText } = await supabaseAdmin
      .from('analysis')
      .insert([{
        site_id: analysisData.site_id,
        url_path: analysisData.url_path,
        structure: analysisData.structure,
        user_id: analysisData.user_id,
        status: analysisData.status,
        request_time: analysisData.request_time,
        provider: analysisData.provider,
        model_id: analysisData.model_id
      }])
      .select()
      .single();
    
    if (error) {
      console.error(`Error creating site analysis: ${error.message}`, {
        code: error.code,
        details: error.details,
        hint: error.hint
      });
      throw new Error(`Error creating site analysis: ${error.message}`);
    }
    
    if (!data) {
      console.error('No data returned from insert operation', { status, statusText });
      throw new Error('No data returned from insert operation');
    }
    
    return data;
  } catch (error: any) {
    console.error('Error in createSiteAnalysis:', error);
    throw new Error(`Error creating site analysis in database: ${error.message}`);
  }
}

/**
 * Updates an existing site analysis
 * 
 * @param analysisId ID of the analysis to update
 * @param updates Fields to update
 * @returns true if successfully updated
 */
export async function updateSiteAnalysis(
  analysisId: string, 
  updates: Partial<Omit<DbSiteAnalysis, 'id' | 'created_at' | 'updated_at'>>
): Promise<boolean> {
  try {
    const { error } = await supabaseAdmin
      .from('analysis')
      .update({
        ...updates,
        updated_at: new Date().toISOString()
      })
      .eq('id', analysisId);
    
    if (error) {
      console.error('Error updating site analysis:', error);
      throw new Error(`Error updating site analysis: ${error.message}`);
    }
    
    return true;
  } catch (error: any) {
    console.error('Error in updateSiteAnalysis:', error);
    throw new Error(`Error updating site analysis: ${error.message}`);
  }
}

/**
 * Gets a site analysis by ID
 * 
 * @param analysisId Analysis ID
 * @returns The site analysis or null if not found
 */
export async function getSiteAnalysisById(analysisId: string): Promise<DbSiteAnalysis | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from('analysis')
      .select('*')
      .eq('id', analysisId)
      .single();
    
    if (error) {
      console.error('Error getting site analysis:', error);
      throw new Error(`Error getting site analysis: ${error.message}`);
    }
    
    return data;
  } catch (error: any) {
    console.error('Error in getSiteAnalysisById:', error);
    throw new Error(`Error getting site analysis: ${error.message}`);
  }
}

/**
 * Gets site analyses for a specific site
 * 
 * @param siteId Site ID
 * @param userId User ID
 * @returns Array of site analyses
 */
export async function getSiteAnalysesBySite(siteId: string, userId: string): Promise<DbSiteAnalysis[]> {
  try {
    const { data, error } = await supabaseAdmin
      .from('analysis')
      .select('*')
      .eq('site_id', siteId)
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    
    if (error) {
      console.error('Error getting site analyses:', error);
      throw new Error(`Error getting site analyses: ${error.message}`);
    }
    
    return data || [];
  } catch (error: any) {
    console.error('Error in getSiteAnalysesBySite:', error);
    throw new Error(`Error getting site analyses: ${error.message}`);
  }
}

/**
 * Updates the status of a site analysis
 * 
 * @param analysisId Analysis ID
 * @param status New status
 * @returns true if successfully updated
 */
export async function updateSiteAnalysisStatus(
  analysisId: string, 
  status: 'completed' | 'failed' | 'processing'
): Promise<boolean> {
  try {
    const { error } = await supabaseAdmin
      .from('analysis')
      .update({
        status,
        updated_at: new Date().toISOString()
      })
      .eq('id', analysisId);
    
    if (error) {
      console.error('Error updating site analysis status:', error);
      throw new Error(`Error updating site analysis status: ${error.message}`);
    }
    
    return true;
  } catch (error: any) {
    console.error('Error in updateSiteAnalysisStatus:', error);
    throw new Error(`Error updating site analysis status: ${error.message}`);
  }
} 