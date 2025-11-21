import { v4 as uuidv4 } from 'uuid';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { RegionLeadsService, Business, SearchResult } from './RegionLeadsService';

// Inicializar el agente y obtener el servicio de comandos
const processorInitializer = ProcessorInitializer.getInstance();
processorInitializer.initialize();
const commandService = processorInitializer.getCommandService();

// Instancia del servicio de búsqueda regional
const regionLeadsService = new RegionLeadsService();

export interface LeadGenerationParams {
  siteId: string;
  userId: string;
  region: string;
  businessType?: string;
  keywords?: string[];
  maxLeads: number;
  priority?: string;
  productInfo?: any;
  contactPreferences?: any;
  lead_id?: string;
  conversation_id?: string;
  webhook?: {
    url: string;
    secret?: string;
    metadata?: any;
  };
}

export interface CommandResult {
  success: boolean;
  commandId?: string;
  error?: string;
  data?: any;
}

/**
 * Servicio para generar leads a partir de negocios en una región
 */
export class RegionLeadsCommandService {
  /**
   * Valida parámetros para generación de leads
   */
  validateLeadParams(params: LeadGenerationParams): { valid: boolean; error?: string } {
    if (!params.siteId) {
      return { valid: false, error: 'siteId is required' };
    }
    
    if (!params.userId) {
      return { valid: false, error: 'userId is required' };
    }
    
    if (!params.region) {
      return { valid: false, error: 'region is required' };
    }

    if (!params.maxLeads || params.maxLeads < 1 || params.maxLeads > 50) {
      return { valid: false, error: 'maxLeads must be between 1 and 50' };
    }
    
    return { valid: true };
  }

  /**
   * Prepara un mensaje de contexto para el comando de generación de leads
   */
  prepareContextMessage(
    region: string, 
    businesses: Business[], 
    businessType: string, 
    keywords: string[],
    productInfo: any,
    contactPreferences: any,
    webhook: any
  ): string {
    let contextMessage = `# Region Lead Generation\n\n`;
    
    // Add region information
    contextMessage += `## Target Region\n`;
    contextMessage += `Region: ${region}\n`;
    
    if (businessType) {
      contextMessage += `Business Type: ${businessType}\n`;
    }
    
    if (keywords && keywords.length > 0) {
      contextMessage += `Keywords: ${keywords.join(', ')}\n`;
    }
    
    // Add businesses information
    contextMessage += `\n## Business Information\n`;
    contextMessage += `Found ${businesses.length} businesses in the region.\n\n`;
    
    // Add first 3 businesses as examples
    const exampleBusinesses = businesses.slice(0, 3);
    exampleBusinesses.forEach((business, index) => {
      contextMessage += `**Business ${index + 1}:** ${business.name}\n`;
      contextMessage += `Address: ${business.address}\n`;
      contextMessage += `Phone: ${business.phone}\n`;
      if (business.website) {
        contextMessage += `Website: ${business.website}\n`;
      }
      contextMessage += `\n`;
    });
    
    // Add product information if available
    if (productInfo && Object.keys(productInfo).length > 0) {
      contextMessage += `\n## Product Information\n`;
      
      if (productInfo.name) {
        contextMessage += `Product/Service: ${productInfo.name}\n`;
      }
      
      if (productInfo.description) {
        contextMessage += `Description: ${productInfo.description}\n`;
      }
      
      if (productInfo.benefits && Array.isArray(productInfo.benefits)) {
        contextMessage += `Benefits:\n`;
        productInfo.benefits.forEach((benefit: string) => {
          contextMessage += `- ${benefit}\n`;
        });
      }
      
      if (productInfo.price) {
        contextMessage += `Price: ${productInfo.price}\n`;
      }
    }
    
    // Add contact preferences if available
    if (contactPreferences && Object.keys(contactPreferences).length > 0) {
      contextMessage += `\n## Contact Preferences\n`;
      
      if (contactPreferences.contactMethod) {
        contextMessage += `Preferred Contact Method: ${contactPreferences.contactMethod}\n`;
      }
      
      if (contactPreferences.contactPerson) {
        contextMessage += `Preferred Contact Person: ${contactPreferences.contactPerson}\n`;
      }
      
      if (contactPreferences.bestTimeToContact) {
        contextMessage += `Best Time to Contact: ${contactPreferences.bestTimeToContact}\n`;
      }
    }
    
    // Add webhook information if available
    if (webhook) {
      contextMessage += `\n## Webhook Information\n`;
      contextMessage += `Webhook URL: ${webhook.url}\n`;
      if (webhook.metadata) {
        contextMessage += `Webhook Metadata: ${JSON.stringify(webhook.metadata)}\n`;
      }
    }

    return contextMessage;
  }

  /**
   * Genera un comando para generar leads a partir de negocios en una región
   */
  async generateLeadsCommand(params: LeadGenerationParams): Promise<CommandResult> {
    try {
      // Validar parámetros
      const validation = this.validateLeadParams(params);
      if (!validation.valid) {
        return {
          success: false,
          error: validation.error
        };
      }

      // Extraer parámetros
      const { 
        siteId, 
        userId,
        region,
        businessType = '',
        keywords = [],
        maxLeads = 10,
        priority = "medium",
        productInfo = {},
        contactPreferences = {},
        webhook,
        lead_id,
        conversation_id
      } = params;

      // Buscar negocios en la región
      const searchResult = await regionLeadsService.searchRegionBusinesses({
        siteId,
        userId,
        region,
        businessType,
        keywords,
        limit: maxLeads
      });
      
      if (!searchResult.success || !searchResult.businesses || searchResult.businesses.length === 0) {
        return {
          success: false,
          error: searchResult.error || 'No businesses found in the region'
        };
      }

      // Preparar mensaje de contexto
      const contextMessage = this.prepareContextMessage(
        region, 
        searchResult.businesses, 
        businessType, 
        keywords,
        productInfo,
        contactPreferences,
        webhook
      );
      
      // Crear targets con información de los negocios
      const targets = searchResult.businesses.map(business => ({
        business: {
          name: business.name,
          address: business.address,
          phone: business.phone,
          website: business.website,
          type: business.types && business.types.length > 0 ? business.types[0] : ''
        }
      }));
      
      // Crear el comando usando CommandFactory
      const command = CommandFactory.createCommand({
        task: "generate and contact leads in region",
        userId: userId,
        site_id: siteId,
        description: `Identify and contact ${maxLeads} potential leads in ${region} for ${productInfo.name || 'our products/services'}.`,
        targets,
        context: contextMessage,
        tools: [
          {
            type: "function",
            function: {
              name: "FIND_CONTACT_PERSON",
              description: "Find contact person at a specific company based on business information",
              parameters: {
                type: "object",
                properties: {
                  business_name: {
                    type: "string",
                    description: "Name of the business"
                  },
                  role: {
                    type: "string",
                    description: "Role or position to look for"
                  }
                },
                required: ["business_name", "role"],
                additionalProperties: false
              },
              strict: true
            }
          },
          {
            type: "function",
            function: {
              name: "PREPARE_CONTACT_MESSAGE",
              description: "Prepare a personalized contact message for the business",
              parameters: {
                type: "object",
                properties: {
                  business_name: {
                    type: "string",
                    description: "Name of the business"
                  },
                  contact_person: {
                    type: "string",
                    description: "Name of the contact person"
                  },
                  product_name: {
                    type: "string",
                    description: "Name of the product or service"
                  }
                },
                required: ["business_name"],
                additionalProperties: false
              },
              strict: true
            }
          }
        ],
        supervisor: [
          {
            agent_role: "lead_qualifier",
            status: "not_initialized"
          },
          {
            agent_role: "outreach_specialist",
            status: "not_initialized"
          }
        ],
        // Set model
        model: "gpt-5.1",
        modelType: "openai",
        // Add metadata
        metadata: webhook ? { 
          webhook_url: webhook.url,
          webhook_secret: webhook.secret,
          webhook_metadata: webhook.metadata,
          region: region,
          businessType: businessType,
          keywords: keywords,
          lead_id: lead_id,
          conversation_id: conversation_id
        } : {
          region: region,
          businessType: businessType,
          keywords: keywords,
          lead_id: lead_id,
          conversation_id: conversation_id
        }
      } as any);
      
      // Enviar comando para procesamiento
      const internalCommandId = await commandService.submitCommand(command);
      console.log(`📝 Region lead generation command created with internal ID: ${internalCommandId}`);
      
      // Guardar comando en la base de datos
      const now = new Date().toISOString();
      const commandRecord = {
        id: uuidv4(),
        internal_id: internalCommandId,
        site_id: siteId,
        user_id: userId,
        task: "region_lead_generation",
        status: "processing",
        target_count: maxLeads,
        priority: priority,
        webhook_url: webhook?.url,
        lead_id: lead_id,
        conversation_id: conversation_id,
        created_at: now,
        updated_at: now,
        metadata: {
          region: region,
          businessType: businessType || null,
          keywords: keywords || [],
          productInfo: productInfo || null,
          contactPreferences: contactPreferences || null,
          businessCount: searchResult.businesses.length,
          lead_id: lead_id,
          conversation_id: conversation_id
        }
      };
      
      try {
        const { data, error } = await supabaseAdmin
          .from('commands')
          .insert([commandRecord])
          .select('id')
          .single();
        
        if (error) {
          console.error('Error storing command in database:', error);
        } else if (data) {
          console.log(`📝 Command stored in database with ID: ${data.id}`);
          
          // Link the command ID to the business leads for tracking
          const businessLeadsMapping = searchResult.businesses.map(business => ({
            id: uuidv4(),
            command_id: data.id,
            business_name: business.name,
            business_id: business.id,
            status: 'pending',
            created_at: now
          }));
          
          await supabaseAdmin
            .from('command_business_mappings')
            .insert(businessLeadsMapping);
          
          // Calcular tiempo estimado de finalización
          const estimatedCompletionTime = new Date();
          estimatedCompletionTime.setMinutes(estimatedCompletionTime.getMinutes() + 15); // Estimar 15 minutos
          
          return {
            success: true,
            commandId: data.id,
            data: {
              command_id: data.id,
              internal_command_id: internalCommandId,
              site_id: siteId,
              status: "processing",
              estimated_completion_time: estimatedCompletionTime.toISOString(),
              region: region,
              businesses_found: searchResult.businesses.length,
              leads_requested: maxLeads,
              job_priority: priority,
              lead_id: lead_id,
              conversation_id: conversation_id,
              process_info: {
                stage: "initial_search",
                progress_percentage: 10
              }
            }
          };
        }
      } catch (dbError) {
        console.error('Error storing command in database:', dbError);
      }
      
      // Si algo falla en la base de datos, aún podemos devolver el ID interno
      const estimatedCompletionTime = new Date();
      estimatedCompletionTime.setMinutes(estimatedCompletionTime.getMinutes() + 15);
      
      return {
        success: true,
        commandId: internalCommandId,
        data: {
          command_id: internalCommandId,
          site_id: siteId,
          status: "processing",
          estimated_completion_time: estimatedCompletionTime.toISOString(),
          region: region,
          businesses_found: searchResult.businesses.length,
          leads_requested: maxLeads,
          job_priority: priority,
          lead_id: lead_id,
          conversation_id: conversation_id,
          process_info: {
            stage: "initial_search",
            progress_percentage: 10
          }
        }
      };
      
    } catch (error) {
      console.error('Error generating leads command:', error);
      return {
        success: false,
        error: 'Failed to generate leads command'
      };
    }
  }

  /**
   * Obtiene el estado de un comando de generación de leads
   */
  async getCommandStatus(commandId: string): Promise<CommandResult> {
    try {
      // Verificar si el ID es un UUID válido
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      const isUuid = uuidRegex.test(commandId);
      
      // Si es un UUID, obtener de la base de datos
      if (isUuid) {
        const { data: commandData, error: commandError } = await supabaseAdmin
          .from('commands')
          .select('*')
          .eq('id', commandId)
          .single();
          
        if (!commandError && commandData) {
          // Obtener las leads asociadas a este comando
          const { data: businessData, error: businessError } = await supabaseAdmin
            .from('command_business_mappings')
            .select('*')
            .eq('command_id', commandId);
            
          const leadStatuses = businessData || [];
          
          // Verificar estado del comando en el servicio de comandos
          let commandDetails = null;
          if (commandData.internal_id) {
            try {
              commandDetails = await commandService.getCommandById(commandData.internal_id);
            } catch (e) {
              console.error('Error fetching command details:', e);
            }
          }
          
          // Calcular progreso
          const totalLeads = leadStatuses.length;
          const processedLeads = leadStatuses.filter(lead => lead.status !== 'pending').length;
          const progressPercentage = totalLeads > 0 ? Math.round((processedLeads / totalLeads) * 100) : 0;
          
          // Determinar etapa actual
          let currentStage = 'initial_search';
          if (commandDetails?.status === 'completed') {
            currentStage = 'completed';
          } else if (progressPercentage > 75) {
            currentStage = 'finalizing_contacts';
          } else if (progressPercentage > 50) {
            currentStage = 'contacting_leads';
          } else if (progressPercentage > 25) {
            currentStage = 'qualifying_leads';
          } else if (progressPercentage > 10) {
            currentStage = 'analyzing_businesses';
          }
          
          return {
            success: true,
            commandId,
            data: {
              status: commandData.status,
              region: commandData.metadata?.region || 'Unknown',
              total_businesses: commandData.metadata?.businessCount || 0,
              target_leads: commandData.target_count || 0,
              processed_leads: processedLeads,
              lead_id: commandData.lead_id || commandData.metadata?.lead_id,
              conversation_id: commandData.conversation_id || commandData.metadata?.conversation_id,
              leads_status: {
                pending: leadStatuses.filter(lead => lead.status === 'pending').length,
                contacted: leadStatuses.filter(lead => lead.status === 'contacted').length,
                qualified: leadStatuses.filter(lead => lead.status === 'qualified').length,
                disqualified: leadStatuses.filter(lead => lead.status === 'disqualified').length,
                converted: leadStatuses.filter(lead => lead.status === 'converted').length
              },
              progress_info: {
                stage: currentStage,
                progress_percentage: progressPercentage
              },
              created_at: commandData.created_at,
              updated_at: commandData.updated_at
            }
          };
        }
      }
      
      // Si no se encuentra en la base de datos o no es un UUID, intentar directamente en el servicio
      const command = await commandService.getCommandById(commandId);
      
      if (!command) {
        return { success: false, error: 'Command not found' };
      }
      
      // Devolver estado basado en el objeto command
      return {
        success: true,
        commandId,
        data: {
          status: command.status,
          region: command.metadata?.region || 'Unknown',
          lead_id: command.metadata?.lead_id,
          conversation_id: command.metadata?.conversation_id,
          progress_info: {
            stage: command.status === 'completed' ? 'completed' : 'processing',
            progress_percentage: command.status === 'completed' ? 100 : 50
          },
          results: command.results || []
        }
      };
    } catch (error) {
      console.error('Error getting command status:', error);
      return { success: false, error: 'Failed to get command status' };
    }
  }
} 