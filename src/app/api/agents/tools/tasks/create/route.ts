import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createTask } from '@/lib/database/task-db';
import { supabaseAdmin } from '@/lib/database/supabase-server';
import { TeamNotificationService } from '@/lib/services/team-notification-service';
import { NotificationService, NotificationType, NotificationPriority } from '@/lib/services/notification-service';
import { sendGridService } from '@/lib/services/sendgrid-service';
import { generateTaskTeamEmailHtml as sharedTeamTemplate, generateTaskUserNotificationHtml as sharedUserTemplate } from '@/lib/services/templates/task-email-templates';

/**
 * Función para transformar diferentes formatos de fecha a ISO 8601
 */
function transformToISO8601(dateInput: any): string | null {
  if (!dateInput) return null;
  
  try {
    // Si ya es un string que parece ISO 8601 con timezone, preservarlo tal como está
    if (typeof dateInput === 'string' && dateInput.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)) {
      const date = new Date(dateInput);
      return isNaN(date.getTime()) ? null : dateInput; // Retornar el original si es válido
    }
    
    // Si es ISO 8601 con milisegundos y timezone, también preservarlo
    if (typeof dateInput === 'string' && dateInput.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/)) {
      const date = new Date(dateInput);
      return isNaN(date.getTime()) ? null : dateInput;
    }
    
    // Si es ISO 8601 con 'Z' al final, también preservarlo
    if (typeof dateInput === 'string' && dateInput.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/)) {
      const date = new Date(dateInput);
      return isNaN(date.getTime()) ? null : dateInput;
    }
    
    // Si es ISO 8601 sin timezone, convertir a UTC
    if (typeof dateInput === 'string' && dateInput.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)) {
      const date = new Date(dateInput);
      return isNaN(date.getTime()) ? null : date.toISOString();
    }

    // Si es un número (timestamp)
    if (typeof dateInput === 'number') {
      // Si parece timestamp en segundos (menos de año 2050 en ms)
      const timestamp = dateInput < 2524608000 ? dateInput * 1000 : dateInput;
      const date = new Date(timestamp);
      return isNaN(date.getTime()) ? null : date.toISOString();
    }

    // Si es un string, intentar diferentes formatos
    if (typeof dateInput === 'string') {
      let dateStr = dateInput.trim();
      
      // Verificar si es una fecha claramente inválida
      if (dateStr.match(/[a-zA-Z]/) && !dateStr.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i)) {
        // Si contiene letras pero no es un formato de fecha conocido, retornar null
        return null;
      }
      
      // Manejar formatos comunes con regex más específicos
      const formats = [
        // YYYY-MM-DD o YYYY/MM/DD
        {
          regex: /^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})(\s+(\d{1,2}):(\d{2})(:(\d{2}))?)?$/,
          order: 'ymd'
        },
        // DD/MM/YYYY o DD-MM-YYYY (día > 12)
        {
          regex: /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(\s+(\d{1,2}):(\d{2})(:(\d{2}))?)?$/,
          order: 'dmy',
          condition: (parts: string[]) => parseInt(parts[0]) > 12
        },
        // MM/DD/YYYY o MM-DD-YYYY (mes > 12)
        {
          regex: /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(\s+(\d{1,2}):(\d{2})(:(\d{2}))?)?$/,
          order: 'mdy',
          condition: (parts: string[]) => parseInt(parts[1]) > 12
        },
        // DD/MM/YYYY o DD-MM-YYYY (por defecto)
        {
          regex: /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(\s+(\d{1,2}):(\d{2})(:(\d{2}))?)?$/,
          order: 'dmy'
        }
      ];

      // Intentar con Date constructor primero para formatos estándar
      let date = new Date(dateStr);
      if (!isNaN(date.getTime()) && dateStr.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i)) {
        return date.toISOString();
      }

      // Intentar parsear manualmente formatos específicos
      for (const format of formats) {
        const match = dateStr.match(format.regex);
        if (match) {
          const [, part1, part2, part3, , hour, minute, , second] = match;
          
          // Verificar condición si existe
          if (format.condition && !format.condition([part1, part2, part3])) {
            continue;
          }
          
          let day: number, month: number, year: number;
          
          switch (format.order) {
            case 'ymd':
              year = parseInt(part1);
              month = parseInt(part2);
              day = parseInt(part3);
              break;
            case 'mdy':
              month = parseInt(part1);
              day = parseInt(part2);
              year = parseInt(part3);
              break;
            case 'dmy':
            default:
              day = parseInt(part1);
              month = parseInt(part2);
              year = parseInt(part3);
              break;
          }

          // Validar rangos
          if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900 || year > 2100) {
            continue;
          }

          // Construir fecha en UTC para evitar problemas de zona horaria
          const h = hour ? parseInt(hour) : 0;
          const m = minute ? parseInt(minute) : 0;
          const s = second ? parseInt(second) : 0;
          
          // Usar UTC para evitar conversiones de zona horaria
          date = new Date(Date.UTC(year, month - 1, day, h, m, s));
          
          if (!isNaN(date.getTime())) {
            return date.toISOString();
          }
        }
      }
    }

    // Último intento: usar Date constructor directamente solo si no contiene letras problemáticas
    if (typeof dateInput === 'string' && !dateInput.match(/[a-zA-Z]/) || 
        (typeof dateInput === 'string' && dateInput.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i))) {
      const date = new Date(dateInput);
      return isNaN(date.getTime()) ? null : date.toISOString();
    }

    return null;
    
  } catch (error) {
    console.warn('[CreateTask] Error transformando fecha:', dateInput, error);
    return null;
  }
}

/**
 * Función para limpiar y transformar los datos de entrada
 */
function preprocessTaskData(data: any) {
  const processed = { ...data };
  
  // Transformar scheduled_date si existe
  if (processed.scheduled_date) {
    const transformedDate = transformToISO8601(processed.scheduled_date);
    if (transformedDate) {
      processed.scheduled_date = transformedDate;
      console.log('[CreateTask] Fecha transformada:', data.scheduled_date, '->', transformedDate);
    } else {
      console.warn('[CreateTask] No se pudo transformar la fecha:', data.scheduled_date);
      // Set default to current time instead of removing to avoid database constraint error
      processed.scheduled_date = new Date().toISOString();
      console.log('[CreateTask] Usando fecha por defecto:', processed.scheduled_date);
    }
  } else {
    // If no scheduled_date provided, set default to current time
    processed.scheduled_date = new Date().toISOString();
    console.log('[CreateTask] No se proporcionó scheduled_date, usando fecha por defecto:', processed.scheduled_date);
  }
  
  return processed;
}

/**
 * Esquema para validar los datos de entrada
 */
const CreateTaskSchema = z.object({
  title: z.string().min(1, 'Título es requerido'),
  description: z.string().optional(),
  type: z.string().min(1, 'Tipo de tarea es requerido'),
  status: z.enum(['in_progress', 'failed', 'pending', 'completed']).default('pending'),
  stage: z.string().default('pending'),
  priority: z.number().int().min(0).default(0),
  lead_id: z.string().uuid('Lead ID debe ser un UUID válido'),
  conversation_id: z.string().uuid('Conversation ID debe ser un UUID válido').optional(),
  user_id: z.string().uuid('User ID debe ser un UUID válido').optional(),
  site_id: z.string().uuid('Site ID es requerido'),
  scheduled_date: z.string()
    .refine((val) => {
      if (!val) return true; // opcional
      // Verificar que sea una fecha válida ISO 8601 (con o sin timezone)
      const iso8601Regex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?(Z|[+-]\d{2}:\d{2})?$/;
      if (!iso8601Regex.test(val)) return false;
      
      // Verificar que la fecha sea válida
      const date = new Date(val);
      return !isNaN(date.getTime());
    }, 'Fecha debe ser ISO 8601 válida (con o sin timezone)')
    .optional(),
  amount: z.number().optional(),
  assignee: z.string().uuid('Assignee debe ser un UUID válido').optional(),
  notes: z.string().optional(),
  command_id: z.string().uuid('Command ID debe ser un UUID válido').optional(),
  address: z.record(z.any()).optional()
});

/**
 * Tipos de tareas válidos
 */
const VALID_TASK_TYPES = [
  'website_visit',
  'demo',
  'meeting',
  'email',
  'call',
  'quote',
  'contract',
  'payment',
  'referral',
  'feedback'
];

/**
 * Obtiene la información del lead y sus relaciones
 */
async function getLeadInfo(leadId: string) {
  try {
    const { data: lead, error } = await supabaseAdmin
      .from('leads')
      .select(`
        id,
        user_id,
        site_id,
        name,
        email,
        company
      `)
      .eq('id', leadId)
      .single();

    if (error || !lead) {
      return null;
    }

    return lead;
  } catch (error) {
    console.error('Error getting lead info:', error);
    return null;
  }
}

/**
 * Genera HTML para email de task creada al TEAM (detallado)
 */
function generateTaskTeamEmailHtml(params: {
  recipientName: string;
  taskTitle: string;
  taskDescription?: string;
  taskType: string;
  priority: number;
  leadName?: string;
  leadEmail?: string;
  assigneeName?: string;
  assigneeEmail?: string;
  scheduledDate?: string;
  taskUrl: string;
  agentName?: string;
}): string {
  // Priority colors and labels (siguiendo el estándar del proyecto)
  const priorityConfig = {
    0: { color: '#10b981', bg: '#ecfdf5', label: 'Low' },
    1: { color: '#3b82f6', bg: '#eff6ff', label: 'Normal' },
    2: { color: '#f59e0b', bg: '#fffbeb', label: 'High' },
    3: { color: '#ef4444', bg: '#fef2f2', label: 'Urgent' }
  };
  
  const priority = priorityConfig[Math.min(params.priority, 3) as keyof typeof priorityConfig] || priorityConfig[1];
  const hasLeadInfo = params.leadName || params.leadEmail;
  
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
  <meta name="color-scheme" content="light dark" />
  <meta name="supported-color-schemes" content="light dark" />
<style type="text/css">
        :root { color-scheme: light dark; }

    .email-header {
      background-color: #1e1e2d !important;
      background-image: linear-gradient(#1e1e2d, #1e1e2d) !important;
    }
    .email-card {
      background-color: #fafafa !important;
      background-image: linear-gradient(#fafafa, #fafafa) !important;
    }
    .email-panel {
      background-color: #f0f0f5 !important;
      background-image: linear-gradient(#f0f0f5, #f0f0f5) !important;
      border: 1px solid #e4e4e7 !important;
    }
    .email-code-box {
      background-color: #f4ffe5 !important;
      background-image: linear-gradient(#f4ffe5, #f4ffe5) !important;
      border: 1px solid #c6f08a !important;
    }

    /* Chips: brand lime + black text (same accent as app primary-button) */
    .email-badge {
      display: inline-block !important;
      background-color: #90ff17 !important;
      background-image: linear-gradient(#90ff17, #90ff17) !important;
      box-shadow: inset 0 0 0 999px #90ff17 !important;
      color: #000000 !important;
      -webkit-text-fill-color: #000000 !important;
      border: 0 !important;
    }
    .email-label {
      color: #3f6212 !important;
      -webkit-text-fill-color: #3f6212 !important;
      font-weight: 600 !important;
    }

    .email-link { color: #000000 !important; -webkit-text-fill-color: #000000 !important; }

    .email-cta-td {
      background-color: #000000 !important;
      background-image: linear-gradient(#000000, #000000) !important;
      box-shadow: inset 0 0 0 999px #000000 !important;
    }
    .email-cta {
      background-color: #000000 !important;
      background-image: linear-gradient(#000000, #000000) !important;
      box-shadow: inset 0 0 0 999px #000000 !important;
      color: #ffffff !important;
      -webkit-text-fill-color: #ffffff !important;
      border: 0 !important;
    }
    .email-cta-label {
      color: #ffffff !important;
      -webkit-text-fill-color: #ffffff !important;
    }

    @media (prefers-color-scheme: light) {
      .email-header-title { color: #f0f0f5 !important; -webkit-text-fill-color: #f0f0f5 !important; }
      .email-header-sub { color: #a1a1aa !important; -webkit-text-fill-color: #a1a1aa !important; }
      .email-heading { color: #1e1e2d !important; -webkit-text-fill-color: #1e1e2d !important; }
      .email-text { color: #334155 !important; -webkit-text-fill-color: #334155 !important; }
      .email-muted { color: #64748b !important; -webkit-text-fill-color: #64748b !important; }
      .email-subtle { color: #64748b !important; -webkit-text-fill-color: #64748b !important; }
      .email-panel,
      .email-panel .email-text,
      .email-panel div,
      .email-panel strong,
      .email-panel p {
        color: #1e1e2d !important;
        -webkit-text-fill-color: #1e1e2d !important;
      }
      .email-code-label { color: #3f6212 !important; -webkit-text-fill-color: #3f6212 !important; }
      .email-code-value { color: #1e1e2d !important; -webkit-text-fill-color: #1e1e2d !important; }
      .email-label { color: #3f6212 !important; -webkit-text-fill-color: #3f6212 !important; }
      .email-link { color: #000000 !important; -webkit-text-fill-color: #000000 !important; }
    }

    @media (prefers-color-scheme: dark) {
      .email-header {
        background-color: #1e1e2d !important;
        background-image: linear-gradient(#1e1e2d, #1e1e2d) !important;
      }
      .email-header-title,
      .email-header h1,
      .email-header p,
      .email-header span,
      .email-header div {
        color: #f0f0f5 !important;
        -webkit-text-fill-color: #f0f0f5 !important;
      }
      .email-header-sub {
        color: #a1a1aa !important;
        -webkit-text-fill-color: #a1a1aa !important;
      }

      .email-card {
        background-color: #15151b !important;
        background-image: linear-gradient(#15151b, #15151b) !important;
        color: #e2e8f0 !important;
      }

      .email-heading,
      .email-text,
      .email-card h1:not(.email-header-title),
      .email-card h2,
      .email-card h3,
      .email-card h4,
      .email-card p,
      .email-card li,
      .email-card td,
      .email-card th,
      .email-card strong,
      .email-card label,
      .email-card div:not(.email-badge):not(.email-cta):not(.email-header):not(.email-cta-td) {
        color: #e2e8f0 !important;
        -webkit-text-fill-color: #e2e8f0 !important;
      }

      .email-muted,
      .email-subtle {
        color: #a1a1aa !important;
        -webkit-text-fill-color: #a1a1aa !important;
      }

      .email-panel {
        background-color: #1e1e2d !important;
        background-image: linear-gradient(#1e1e2d, #1e1e2d) !important;
        border: 1px solid #2d2d3d !important;
      }
      .email-panel,
      .email-panel .email-text,
      .email-panel .email-muted,
      .email-panel .email-label,
      .email-panel div:not(.email-badge),
      .email-panel p,
      .email-panel strong,
      .email-panel span:not(.email-badge):not(.email-cta-label) {
        color: #e2e8f0 !important;
        -webkit-text-fill-color: #e2e8f0 !important;
      }
      .email-panel a.email-link {
        color: #ffffff !important;
        -webkit-text-fill-color: #ffffff !important;
      }

      .email-code-box {
        background-color: #1e1e2d !important;
        background-image: linear-gradient(#1e1e2d, #1e1e2d) !important;
        border: 1px solid #3f6212 !important;
      }
      .email-code-label {
        color: #bef264 !important;
        -webkit-text-fill-color: #bef264 !important;
      }
      .email-code-value {
        color: #e2e8f0 !important;
        -webkit-text-fill-color: #e2e8f0 !important;
      }

      .email-link {
        color: #ffffff !important;
        -webkit-text-fill-color: #ffffff !important;
      }

      /* Lime badge stays brand accent in dark (black text on lime) */
      .email-badge,
      .email-card .email-badge,
      .email-panel .email-badge {
        background-color: #90ff17 !important;
        background-image: linear-gradient(#90ff17, #90ff17) !important;
        box-shadow: inset 0 0 0 999px #90ff17 !important;
        color: #000000 !important;
        -webkit-text-fill-color: #000000 !important;
      }
      .email-label {
        color: #bef264 !important;
        -webkit-text-fill-color: #bef264 !important;
      }

      .email-cta-td {
        background-color: #ffffff !important;
        background-image: linear-gradient(#ffffff, #ffffff) !important;
        box-shadow: inset 0 0 0 999px #ffffff !important;
      }
      .email-cta {
        background-color: #ffffff !important;
        background-image: linear-gradient(#ffffff, #ffffff) !important;
        box-shadow: inset 0 0 0 999px #ffffff !important;
        color: #000000 !important;
        -webkit-text-fill-color: #000000 !important;
        border: 0 !important;
      }
      .email-cta-label,
      .email-cta span {
        color: #000000 !important;
        -webkit-text-fill-color: #000000 !important;
      }
    }
      .email-header-title,
      .email-header h1,
      .email-header p,
      .email-header span,
      .email-header div {
        color: #f0f0f5 !important;
        -webkit-text-fill-color: #f0f0f5 !important;
      }
      .email-header-sub {
        color: #a1a1aa !important;
        -webkit-text-fill-color: #a1a1aa !important;
      }

      .email-card {
        background-color: #15151b !important;
        background-image: linear-gradient(#15151b, #15151b) !important;
        color: #e2e8f0 !important;
      }

      .email-heading,
      .email-text,
      .email-card h1:not(.email-header-title),
      .email-card h2,
      .email-card h3,
      .email-card h4,
      .email-card p,
      .email-card li,
      .email-card td,
      .email-card th,
      .email-card strong,
      .email-card label,
      .email-card div:not(.email-badge):not(.email-cta):not(.email-header):not(.email-cta-td) {
        color: #e2e8f0 !important;
        -webkit-text-fill-color: #e2e8f0 !important;
      }

      .email-muted,
      .email-subtle {
        color: #a1a1aa !important;
        -webkit-text-fill-color: #a1a1aa !important;
      }

      .email-panel {
        background-color: #1e1e2d !important;
        background-image: linear-gradient(#1e1e2d, #1e1e2d) !important;
        border: 1px solid #2d2d3d !important;
      }
      .email-panel,
      .email-panel .email-text,
      .email-panel div:not(.email-badge),
      .email-panel p,
      .email-panel strong,
      .email-panel span:not(.email-badge):not(.email-cta-label) {
        color: #e2e8f0 !important;
        -webkit-text-fill-color: #e2e8f0 !important;
      }

      .email-code-box {
        background-color: #1e1e2d !important;
        background-image: linear-gradient(#1e1e2d, #1e1e2d) !important;
        border: 1px solid #2d2d3d !important;
      }
      .email-code-label {
        color: #a1a1aa !important;
        -webkit-text-fill-color: #a1a1aa !important;
      }
      .email-code-value {
        color: #e2e8f0 !important;
        -webkit-text-fill-color: #e2e8f0 !important;
      }

      .email-link {
        color: #ffffff !important;
        -webkit-text-fill-color: #ffffff !important;
      }

      /* Badges stay saturated accent (do not get washed out by card text rules) */
      .email-badge,
      .email-card .email-badge,
      .email-panel .email-badge {
        background-color: #90ff17 !important;
        background-image: linear-gradient(#90ff17, #90ff17) !important;
        box-shadow: inset 0 0 0 999px #90ff17 !important;
        color: #000000 !important;
        -webkit-text-fill-color: #000000 !important;
      }
      .email-label {
        color: #a1a1aa !important;
        -webkit-text-fill-color: #a1a1aa !important;
      }

      .email-cta-td {
        background-color: #ffffff !important;
        background-image: linear-gradient(#ffffff, #ffffff) !important;
        box-shadow: inset 0 0 0 999px #ffffff !important;
      }
      .email-cta {
        background-color: #ffffff !important;
        background-image: linear-gradient(#ffffff, #ffffff) !important;
        box-shadow: inset 0 0 0 999px #ffffff !important;
        color: #000000 !important;
        -webkit-text-fill-color: #000000 !important;
        border: 0 !important;
      }
      .email-cta-label,
      .email-cta span {
        color: #000000 !important;
        -webkit-text-fill-color: #000000 !important;
      }
    }
      .email-header-title { color: #f0f0f5 !important; }
      .email-header-sub { color: #a1a1aa !important; }

      .email-card {
        background-color: #15151b !important;
        background-image: linear-gradient(#15151b, #15151b) !important;
        color: #e2e8f0 !important;
      }

      /* Readable copy when Mail inverts the card */
      .email-heading,
      .email-text,
      .email-card h1:not(.email-header-title),
      .email-card h2,
      .email-card h3,
      .email-card h4,
      .email-card p,
      .email-card li,
      .email-card td,
      .email-card th,
      .email-card strong,
      .email-card label,
      .email-card span:not(.email-cta-label):not(.email-header-sub) {
        color: #e2e8f0 !important;
      }

      .email-muted,
      .email-subtle,
      .email-card .email-muted,
      .email-card .email-subtle {
        color: #a1a1aa !important;
      }

      .email-panel {
        background-color: #1e1e2d !important;
        background-image: linear-gradient(#1e1e2d, #1e1e2d) !important;
        border: 1px solid #2d2d3d !important;
        color: #e2e8f0 !important;
      }
      .email-panel,
      .email-panel div,
      .email-panel p,
      .email-panel strong,
      .email-panel span:not(.email-cta-label) {
        color: #e2e8f0 !important;
      }

      .email-badge {
        background-color: #2d2d3d !important;
        background-image: linear-gradient(#2d2d3d, #2d2d3d) !important;
        color: #a1a1aa !important;
      }

      .email-link { color: #ffffff !important; }

      .email-cta-td {
        background-color: #ffffff !important;
        background-image: linear-gradient(#ffffff, #ffffff) !important;
        box-shadow: inset 0 0 0 999px #ffffff !important;
      }
      .email-cta {
        background-color: #ffffff !important;
        background-image: linear-gradient(#ffffff, #ffffff) !important;
        box-shadow: inset 0 0 0 999px #ffffff !important;
        color: #000000 !important;
        border: 0 !important;
      }
      .email-cta-label,
      .email-cta span {
        color: #000000 !important;
      }

      .email-code-box {
        background-color: #1e1e2d !important;
        background-image: linear-gradient(#1e1e2d, #1e1e2d) !important;
        border: 1px solid #2d2d3d !important;
      }
      .email-code-label { color: #a1a1aa !important; }
      .email-code-value { color: #e2e8f0 !important; }

      /* Keep header children light even if nested rules race */
      .email-header,
      .email-header h1,
      .email-header p,
      .email-header span,
      .email-header div {
        color: #f0f0f5 !important;
      }
      .email-header .email-header-sub { color: #a1a1aa !important; }
    }
          .email-header-title { color: #e2e8f0 !important; }
          .email-header-sub { color: #a1a1aa !important; }
          .email-panel {
            background-color: #1e1e2d !important;
            background-image: linear-gradient(#1e1e2d, #1e1e2d) !important;
            border-color: #2d2d3d !important;
          }
          .email-card {
            background-color: #15151b !important;
            background-image: linear-gradient(#15151b, #15151b) !important;
          }
          .email-link { color: #ffffff !important; }
          .email-cta-td {
            background-color: #ffffff !important;
            background-image: linear-gradient(#ffffff, #ffffff) !important;
            box-shadow: inset 0 0 0 999px #ffffff !important;
          }
          .email-cta {
            background-color: #ffffff !important;
            background-image: linear-gradient(#ffffff, #ffffff) !important;
            box-shadow: inset 0 0 0 999px #ffffff !important;
            color: #000000 !important;
            border: 0 !important;
          }
          .email-cta-label { color: #000000 !important; }
        }
          .email-cta-label { color: #000000 !important; }
        }
        }
        }
</style>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>New Task Assigned</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f8fafc; line-height: 1.6;">
      
      <!-- Main Container -->
      <div class="email-card" style="max-width: 600px; margin: 40px auto; background-color: #fafafa; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); overflow: hidden;">
        
        <!-- Header -->
        <div class="email-header" style="background: #1e1e2d; padding: 32px 40px; text-align: center;">
          <div style="display: inline-block; background-color: rgba(255, 255, 255, 0.1); border-radius: 50%; padding: 12px; margin-bottom: 16px;">
            <div style="width: 24px; height: 24px; background-color: #ffffff; border-radius: 4px; position: relative;">
              <div style="position: absolute; top: 6px; left: 6px; width: 12px; height: 8px; border: 2px solid #000000; border-top: none; border-right: none; transform: rotate(-45deg);"></div>
            </div>
          </div>
          <h1 style="margin: 0; color: #f0f0f5; font-size: 24px; font-weight: 600; letter-spacing: -0.025em;">New Task Assigned</h1>
          <p style="margin: 8px 0 0; color: #a1a1aa; font-size: 16px; font-weight: 400;">A new task has been created and assigned to you</p>
        </div>
        
        <!-- Content -->
        <div style="padding: 40px;">
          
          <!-- Priority Badge -->
          <div style="margin-bottom: 32px;">
            <div class="email-badge" style="display: inline-block; background-color: ${priority.bg}; color: ${priority.color}; padding: 8px 16px; border-radius: 20px; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;">
              ${priority.label} Priority
            </div>
          </div>
          
          <!-- Main Message -->
          <div style="margin-bottom: 32px;">
            <p class="email-text" style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 500;">
              Hi ${params.recipientName},
            </p>
            <p class="email-text" style="margin: 0 0 16px; font-size: 16px; color: #475569;">
              ${params.agentName ? `${params.agentName} has` : 'A'} created a new task that has been assigned to you.
            </p>
            
            <!-- Task Quote -->
            <div style="background-color: #f8fafc; border-left: 4px solid #90ff17; padding: 20px 24px; border-radius: 0 8px 8px 0; margin: 24px 0;">
              <h3 class="email-heading" style="margin: 0 0 8px; font-size: 18px; color: #1e293b; font-weight: 600;">
                ${params.taskTitle}
              </h3>
              ${params.taskDescription ? `
              <p class="email-text" style="margin: 0; font-size: 15px; color: #475569; line-height: 1.6;">
                ${params.taskDescription}
              </p>
              ` : ''}
            </div>
          </div>
          
          <!-- Task Details -->
          <div style="margin-bottom: 32px;">
            <h3 class="email-heading" style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600;">Task Details</h3>
            <div style="background-color: #f1f5f9; padding: 20px 24px; border-radius: 8px; border: 1px solid #e2e8f0;">
              <div style="margin-bottom: 12px;">
                <span class="email-text" style="display: inline-block; font-weight: 600; color: #1e293b; min-width: 80px;">Type:</span>
                <span class="email-text" style="color: #475569; font-size: 15px;">${params.taskType}</span>
              </div>
              ${params.scheduledDate ? `
              <div>
                <span class="email-text" style="display: inline-block; font-weight: 600; color: #1e293b; min-width: 80px;">Due:</span>
                <span class="email-text" style="color: #475569; font-size: 15px;">${new Date(params.scheduledDate).toLocaleDateString((params as any).locale === 'es' ? 'es-ES' : (params as any).locale === 'fr' ? 'fr-FR' : (params as any).locale === 'de' ? 'de-DE' : (params as any).locale === 'ja' ? 'ja-JP' : 'en-US', {
                  weekday: 'long', 
                  year: 'numeric', 
                  month: 'long', 
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit'
                })}</span>
              </div>
              ` : ''}
            </div>
          </div>
          
          ${hasLeadInfo ? `
          <!-- Lead Information -->
          <div style="margin-bottom: 32px;">
            <h3 class="email-heading" style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600;">Related Lead</h3>
            <div style="background-color: #eff6ff; padding: 20px 24px; border-radius: 8px; border: 1px solid #bfdbfe;">
              ${params.leadName ? `
              <div style="margin-bottom: 12px;">
                <span class="email-label" style="display: inline-block; font-weight: 600; color: #1e40af; min-width: 60px;">Name:</span>
                <span class="email-text" style="color: #1e293b; font-size: 15px;">${params.leadName}</span>
              </div>
              ` : ''}
              ${params.leadEmail ? `
              <div>
                <span class="email-label" style="display: inline-block; font-weight: 600; color: #1e40af; min-width: 60px;">Email:</span>
                <a href="mailto:${params.leadEmail}" style="color: #000000; font-weight: 600; text-decoration: none; font-size: 15px; border-bottom: 1px solid transparent; transition: border-color 0.2s;">
                  ${params.leadEmail}
                </a>
              </div>
              ` : ''}
            </div>
          </div>
          ` : ''}
          
          <!-- Action Button -->
          <div style="text-align: center; margin: 40px 0 32px;">
            <a href="${params.taskUrl}" 
               class="email-cta" style="background: #000000; background-color: #000000; background-image: linear-gradient(#000000, #000000); box-shadow: inset 0 0 0 999px #000000; color: #ffffff; border: 0; display: inline-block; font-weight: 600; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; box-shadow: 0 2px 4px rgba(102, 126, 234, 0.2);">
              View Task Details
            </a>
          </div>
          
          <!-- Next Steps -->
          <div style="margin-bottom: 32px;">
            <h3 class="email-heading" style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600;">What's next?</h3>
            <div style="background-color: #ecfdf5; padding: 20px 24px; border-radius: 8px; border: 1px solid #a7f3d0;">
              <div style="margin-bottom: 12px;">
                <div style="display: flex; align-items: flex-start; margin-bottom: 8px;">
                  <span style="display: inline-block; width: 20px; height: 20px; background-color: #000000; font-weight: 600; border-radius: 50%; margin-right: 12px; margin-top: 2px; flex-shrink: 0; text-align: center; line-height: 20px; color: white; font-size: 12px; font-weight: 600;">1</span>
                  <span style="color: #065f46; font-size: 15px; line-height: 1.4;">Review the task details and requirements</span>
                </div>
                <div style="display: flex; align-items: flex-start; margin-bottom: 8px;">
                  <span style="display: inline-block; width: 20px; height: 20px; background-color: #000000; font-weight: 600; border-radius: 50%; margin-right: 12px; margin-top: 2px; flex-shrink: 0; text-align: center; line-height: 20px; color: white; font-size: 12px; font-weight: 600;">2</span>
                  <span style="color: #065f46; font-size: 15px; line-height: 1.4;">Update the task status as you progress</span>
                </div>
                <div style="display: flex; align-items: flex-start;">
                  <span style="display: inline-block; width: 20px; height: 20px; background-color: #000000; font-weight: 600; border-radius: 50%; margin-right: 12px; margin-top: 2px; flex-shrink: 0; text-align: center; line-height: 20px; color: white; font-size: 12px; font-weight: 600;">3</span>
                  <span style="color: #065f46; font-size: 15px; line-height: 1.4;">Mark it as completed when finished</span>
                </div>
              </div>
            </div>
          </div>
          
          <!-- Footer -->
          <div style="text-align: center; padding: 24px 0; border-top: 1px solid #e5e7eb;">
            <p style="margin: 0; color: #9ca3af; font-size: 14px;">
              This email was sent automatically by the Makinari task management system.
            </p>
          </div>
          
        </div>
      </div>
    </body>
    </html>
  `;
}

/**
 * Genera HTML para notificación del USUARIO sobre task creada (simple)
 */
async function generateTaskUserNotificationHtml(params: {
  taskId: string;
  taskTitle: string;
  taskDescription?: string;
  taskType: string;
  priority: number;
  leadName?: string;
  leadEmail?: string;
  assigneeName?: string;
  assigneeEmail?: string;
  scheduledDate?: string;
  taskUrl: string;
}): Promise<string> {
  // Priority colors and labels
  const priorityConfig = {
    0: { color: '#6b7280', bg: '#f9fafb', label: 'Low' },
    1: { color: '#3b82f6', bg: '#eff6ff', label: 'Normal' },
    2: { color: '#f59e0b', bg: '#fffbeb', label: 'High' },
    3: { color: '#ef4444', bg: '#fef2f2', label: 'Urgent' }
  };
  
  const priority = priorityConfig[Math.min(params.priority, 3) as keyof typeof priorityConfig] || priorityConfig[1];
  
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>New Task Created</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f8fafc; line-height: 1.6;">
      
      <!-- Main Container -->
      <div class="email-card" style="max-width: 600px; margin: 40px auto; background-color: #fafafa; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); overflow: hidden;">
        
        <!-- Header -->
        <div class="email-header" style="background: #1e1e2d; padding: 32px 40px; text-align: center;">
          <div style="display: inline-block; background-color: rgba(255, 255, 255, 0.1); border-radius: 50%; padding: 12px; margin-bottom: 16px;">
            <div style="width: 24px; height: 24px; background-color: #ffffff; border-radius: 4px; position: relative;">
              <div style="position: absolute; top: 6px; left: 6px; width: 12px; height: 8px; border: 2px solid #000000; border-top: none; border-right: none; transform: rotate(-45deg);"></div>
            </div>
          </div>
          <h1 style="margin: 0; color: #f0f0f5; font-size: 24px; font-weight: 600; letter-spacing: -0.025em;">New Task Created</h1>
          <p style="margin: 8px 0 0; color: #a1a1aa; font-size: 16px; font-weight: 400;">A new task has been added to the system</p>
        </div>
        
        <!-- Content -->
        <div style="padding: 40px;">
          
          <!-- Task Details -->
          <div style="margin-bottom: 32px; background-color: #f9fafb; border-radius: 12px; padding: 24px; border: 1px solid #e5e7eb;">
            <h2 class="email-heading" style="margin: 0 0 16px; font-size: 20px; color: #111827; font-weight: 600;">
              ${params.taskTitle}
            </h2>
            
            ${params.taskDescription ? `
            <div style="margin-bottom: 20px;">
              <p class="email-muted" style="margin: 0; font-size: 15px; color: #6b7280; line-height: 1.6;">
                ${params.taskDescription}
              </p>
            </div>
            ` : ''}
            
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 20px;">
              <div>
                <span class="email-label" style="display: block; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase; margin-bottom: 4px;">Task Type</span>
                <span class="email-text" style="font-size: 14px; color: #111827; font-weight: 500;">${params.taskType}</span>
              </div>
              <div>
                <span class="email-label" style="display: block; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase; margin-bottom: 4px;">Priority</span>
                <span style="display: inline-block; background-color: ${priority.bg}; color: ${priority.color}; padding: 4px 8px; border-radius: 6px; font-size: 12px; font-weight: 600;">
                  ${priority.label}
                </span>
              </div>
            </div>
            
            ${params.scheduledDate ? `
            <div style="margin-top: 16px;">
              <span class="email-label" style="display: block; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase; margin-bottom: 4px;">Scheduled Date</span>
              <span class="email-text" style="font-size: 14px; color: #111827; font-weight: 500;">${new Date(params.scheduledDate).toLocaleDateString((params as any).locale === 'es' ? 'es-ES' : (params as any).locale === 'fr' ? 'fr-FR' : (params as any).locale === 'de' ? 'de-DE' : (params as any).locale === 'ja' ? 'ja-JP' : 'en-US', {
                weekday: 'long', 
                year: 'numeric', 
                month: 'long', 
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
              })}</span>
            </div>
            ` : ''}
          </div>
          
          ${params.assigneeName || params.assigneeEmail ? `
          <!-- Assignee Information -->
          <div style="margin-bottom: 32px;">
            <h3 class="email-heading" style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600;">Assigned To</h3>
            <div style="background-color: #ecfdf5; padding: 20px 24px; border-radius: 8px; border: 1px solid #a7f3d0;">
              ${params.assigneeName ? `
              <div style="margin-bottom: 12px;">
                <span class="email-label" style="display: inline-block; font-weight: 600; color: #065f46; min-width: 60px;">Name:</span>
                <span class="email-text" style="color: #1e293b; font-size: 15px;">${params.assigneeName}</span>
              </div>
              ` : ''}
              ${params.assigneeEmail ? `
              <div>
                <span class="email-label" style="display: inline-block; font-weight: 600; color: #065f46; min-width: 60px;">Email:</span>
                <a href="mailto:${params.assigneeEmail}" style="color: #000000; font-weight: 600; text-decoration: none; font-size: 15px;">
                  ${params.assigneeEmail}
                </a>
              </div>
              ` : ''}
            </div>
          </div>
          ` : ''}
          
          ${params.leadName || params.leadEmail ? `
          <!-- Lead Information -->
          <div style="margin-bottom: 32px;">
            <h3 class="email-heading" style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600;">Related Lead</h3>
            <div style="background-color: #eff6ff; padding: 20px 24px; border-radius: 8px; border: 1px solid #bfdbfe;">
              ${params.leadName ? `
              <div style="margin-bottom: 12px;">
                <span class="email-label" style="display: inline-block; font-weight: 600; color: #1e40af; min-width: 60px;">Name:</span>
                <span class="email-text" style="color: #1e293b; font-size: 15px;">${params.leadName}</span>
              </div>
              ` : ''}
              ${params.leadEmail ? `
              <div>
                <span class="email-label" style="display: inline-block; font-weight: 600; color: #1e40af; min-width: 60px;">Email:</span>
                <a href="mailto:${params.leadEmail}" style="color: #000000; font-weight: 600; text-decoration: none; font-size: 15px;">
                  ${params.leadEmail}
                </a>
              </div>
              ` : ''}
            </div>
          </div>
          ` : ''}
          
          <!-- Action Button -->
          <div style="text-align: center; margin: 40px 0 32px;">
            <a href="${params.taskUrl}" 
               class="email-cta" style="background: #000000; background-color: #000000; background-image: linear-gradient(#000000, #000000); box-shadow: inset 0 0 0 999px #000000; color: #ffffff; border: 0; display: inline-block; font-weight: 600; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; box-shadow: 0 2px 4px rgba(99, 102, 241, 0.2);">
              View Task Details
            </a>
          </div>
          
          <!-- Footer -->
          <div style="text-align: center; padding: 24px 0; border-top: 1px solid #e5e7eb;">
            <p style="margin: 0; color: #9ca3af; font-size: 14px;">
              This email was sent automatically by the Makinari task management system.
            </p>
          </div>
          
        </div>
      </div>
    </body>
    </html>
  `;
}

/**
 * POST endpoint para crear una nueva tarea
 */
export async function POST(request: NextRequest) {
  try {
    console.log('[CreateTask] Iniciando creación de tarea');

    const body = await request.json();
    console.log('[CreateTask] Datos recibidos:', JSON.stringify(body, null, 2));

    // Preprocesar los datos para transformar fechas
    const preprocessedData = preprocessTaskData(body);
    console.log('[CreateTask] Datos preprocesados:', JSON.stringify(preprocessedData, null, 2));

    // Validar los datos de entrada
    const validatedData = CreateTaskSchema.parse(preprocessedData);
    console.log('[CreateTask] Datos validados correctamente');

    // Obtener información del lead
    console.log('[CreateTask] Obteniendo información del lead:', validatedData.lead_id);
    const leadInfo = await getLeadInfo(validatedData.lead_id);
    
    if (!leadInfo) {
      return NextResponse.json({
        success: false,
        error: 'Lead no encontrado'
      }, { status: 404 });
    }

    if (leadInfo.site_id !== validatedData.site_id) {
      return NextResponse.json({
        success: false,
        error: 'El lead no pertenece a este sitio'
      }, { status: 403 });
    }

    console.log('[CreateTask] Información del lead obtenida:', leadInfo);

    // Usar datos del lead si no se especificaron
    const taskData = {
      title: validatedData.title,
      description: validatedData.description,
      type: validatedData.type,
      status: validatedData.status,
      stage: validatedData.stage,
      priority: validatedData.priority,
      user_id: validatedData.user_id || leadInfo.user_id, // Usar del lead si no se especifica
      site_id: validatedData.site_id || leadInfo.site_id, // Usar del lead si no se especifica
      lead_id: validatedData.lead_id,
      scheduled_date: validatedData.scheduled_date,
      amount: validatedData.amount,
      assignee: validatedData.assignee,
      notes: validatedData.notes,
      command_id: validatedData.command_id,
      address: validatedData.address
    };

    console.log('[CreateTask] Datos finales para crear tarea:', taskData);

    // Crear la tarea
    console.log('[CreateTask] Llamando a createTask...');
    try {
      const newTask = await createTask(taskData);
      console.log('[CreateTask] Tarea creada exitosamente:', newTask.id);

      // ========== NOTIFICACIONES ==========
      console.log('[CreateTask] Iniciando proceso de notificaciones...');
      
      // Preparar datos para notificaciones
      const siteId = newTask.site_id;
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.uncodie.com';
      // CTA correcto: app_url/control-center/{task_id}
      const controlCenterUrl = `${appUrl}/control-center/${newTask.id}`;
      const teamTaskUrl = controlCenterUrl;
      
      // Obtener información adicional del lead y assignee si existen
      let leadNotificationInfo = null;
      let assigneeInfo = null;
      
      // Obtener información del lead
      if (newTask.lead_id) {
        try {
          const { data: lead } = await supabaseAdmin
            .from('leads')
            .select('name, email')
            .eq('id', newTask.lead_id)
            .single();
          leadNotificationInfo = lead;
        } catch (error) {
          console.warn('[CreateTask] Error obteniendo información del lead:', error);
        }
      }
      
      // Obtener información del assignee
      if (newTask.assignee) {
        try {
          const { data: assignee } = await supabaseAdmin.auth.admin.getUserById(newTask.assignee);
          if (assignee?.user) {
            assigneeInfo = {
              name: assignee.user.user_metadata?.name || assignee.user.email,
              email: assignee.user.email
            };
          }
        } catch (error) {
          console.warn('[CreateTask] Error obteniendo información del assignee:', error);
        }
      }

      // 1. Notificar al team
      console.log('[CreateTask] 📢 Notificando al team...');
      const teamNotificationResult = await TeamNotificationService.notifyTeam({
        siteId: siteId,
        title: `New task created: ${newTask.title}`,
        message: `A new ${newTask.type} task has been created${leadNotificationInfo?.name ? ` for lead ${leadNotificationInfo.name}` : ''}.`,
        htmlContent: generateTaskTeamEmailHtml({
          recipientName: 'Team',
          taskTitle: newTask.title,
          taskDescription: newTask.description || undefined,
          taskType: newTask.type,
          priority: newTask.priority,
          leadName: leadNotificationInfo?.name || undefined,
          leadEmail: leadNotificationInfo?.email || undefined,
          assigneeName: assigneeInfo?.name || undefined,
          assigneeEmail: assigneeInfo?.email || undefined,
          scheduledDate: newTask.scheduled_date || undefined,
          taskUrl: teamTaskUrl,
          agentName: 'System'
        }),
        priority: newTask.priority >= 10 ? 'high' : newTask.priority >= 5 ? 'normal' : 'low',
        type: NotificationType.INFO,
        categories: ['task-notification', 'task-created'],
        customArgs: {
          taskId: newTask.id,
          taskType: newTask.type,
          leadId: newTask.lead_id || ''
        },
        relatedEntityType: 'task',
        relatedEntityId: newTask.id
      });

      // 2. Crear notificación en la app para el assignee
      let appNotificationResult = null;
      if (newTask.assignee) {
        console.log('[CreateTask] 🔔 Creando notificación en la app...');
        appNotificationResult = await NotificationService.createNotification({
          user_id: newTask.assignee,
          site_id: siteId,
          title: `New task assigned: ${newTask.title}`,
          message: `You have been assigned a new ${newTask.type} task${leadNotificationInfo?.name ? ` for lead ${leadNotificationInfo.name}` : ''}.`,
          type: NotificationType.INFO,
          priority: newTask.priority >= 10 ? NotificationPriority.HIGH : 
                   newTask.priority >= 5 ? NotificationPriority.NORMAL : NotificationPriority.LOW,
          related_entity_type: 'task',
          related_entity_id: newTask.id
        });
      }

      // 3. Enviar resumen por email al usuario (assignee o lead)
      let taskNotificationResult: { success: boolean; messageId?: string } = { success: false };
      const recipientEmail = assigneeInfo?.email || leadNotificationInfo?.email;
      
      if (recipientEmail) {
        console.log('[CreateTask] 📧 Enviando resumen por email a:', recipientEmail);
        
        // Template más simple para el usuario (lo lleva al sitio donde está el chat)
        const recipientName = assigneeInfo?.name || leadNotificationInfo?.name || 'User';
        const subject = `New task assigned: ${newTask.title}`;
        const html = await generateTaskUserNotificationHtml({
          taskId: newTask.id,
          taskTitle: newTask.title,
          taskDescription: newTask.description || undefined,
          taskType: newTask.type,
          priority: newTask.priority,
          leadName: leadNotificationInfo?.name || undefined,
          leadEmail: leadNotificationInfo?.email || undefined,
          assigneeName: assigneeInfo?.name || undefined,
          assigneeEmail: assigneeInfo?.email || undefined,
          scheduledDate: newTask.scheduled_date || undefined,
          taskUrl: controlCenterUrl
        });
        
        taskNotificationResult = await sendGridService.sendEmail({
          to: recipientEmail,
          subject,
          html,
          categories: ['task-notification', 'task-created', 'transactional'],
          customArgs: {
            taskId: newTask.id,
            taskType: newTask.type,
            agentName: 'System'
          }
        });
      } else {
        console.log('[CreateTask] 📧 No hay email para notificar sobre la task creada');
        taskNotificationResult = { success: true };
      }

      // Log de resultados de notificaciones
      console.log('[CreateTask] ✅ Resultados de notificaciones:', {
        team: {
          success: teamNotificationResult.success,
          notifications_sent: teamNotificationResult.notificationsSent,
          emails_sent: teamNotificationResult.emailsSent
        },
        app_notification: {
          success: !!appNotificationResult,
          assignee: newTask.assignee
        },
        user_email: {
          success: taskNotificationResult.success,
          recipient: assigneeInfo?.email || leadNotificationInfo?.email
        }
      });

      return NextResponse.json({
        success: true,
        task: newTask,
        notifications: {
          team_notification: {
            success: teamNotificationResult.success,
            notifications_sent: teamNotificationResult.notificationsSent,
            emails_sent: teamNotificationResult.emailsSent,
            total_members: teamNotificationResult.totalMembers
          },
          app_notification: {
            created: !!appNotificationResult,
            assignee_id: newTask.assignee
          },
          user_email: {
            sent: taskNotificationResult.success,
            recipient: assigneeInfo?.email || leadNotificationInfo?.email,
            message_id: taskNotificationResult.messageId
          }
        }
      }, { status: 201 });
    } catch (createError: any) {
      console.error('[CreateTask] Error en createTask:', createError);
      return NextResponse.json({
        success: false,
        error: `Error creando tarea: ${createError.message}`
      }, { status: 500 });
    }

  } catch (error) {
    console.error('[CreateTask] Error inesperado:', error);

    if (error instanceof z.ZodError) {
      return NextResponse.json({
        success: false,
        error: 'Datos de entrada inválidos',
        details: error.errors
      }, { status: 400 });
    }

    // Si es un error de la base de datos
    if (error instanceof Error && error.message.includes('Error creating task')) {
      return NextResponse.json({
        success: false,
        error: error.message
      }, { status: 500 });
    }

    return NextResponse.json({
      success: false,
      error: 'Error interno del servidor'
    }, { status: 500 });
  }
}

/**
 * GET endpoint para información sobre la API
 */
export async function GET() {
  return NextResponse.json({
    message: "API de creación de tareas",
    description: "Crea una nueva tarea en el sistema con información automática del lead",
    usage: "Envía una solicitud POST con los datos de la tarea",
    endpoint: "/api/agents/tools/tasks/create",
    methods: ["POST", "GET"],
    required_fields: [
      "title",
      "type", 
      "lead_id"
    ],
    optional_fields: [
      "description",
      "status",
      "stage", 
      "priority",
      "user_id", // Se obtiene del lead automáticamente si no se especifica
      "site_id", // Se obtiene del lead automáticamente si no se especifica
      "scheduled_date",
      "amount",
      "assignee",
      "notes",
      "command_id",
      "address"
    ],
    task_statuses: ["in_progress", "failed", "pending", "completed"],
    task_stages: "String libre (etapas del customer_journey, ej: 'awareness', 'consideration', 'decision')",
    task_types: "String libre (cualquier tipo personalizado permitido, ej: 'call', 'email', 'demo', 'custom_type')",
    priority_levels: "Número entero (0 = más baja, números más altos = mayor prioridad)",
    date_formats: {
      description: "La API acepta múltiples formatos de fecha y los convierte automáticamente a ISO 8601. Las fechas con timezone se preservan tal como vienen.",
      supported_formats: [
        "ISO 8601 con timezone: '2023-12-15T14:00:00-06:00' (se preserva tal como está)",
        "ISO 8601 UTC: '2023-12-15T14:00:00Z' (se preserva tal como está)",
        "ISO 8601 sin timezone: '2023-12-15T14:00:00' (se convierte a UTC)",
        "DD/MM/YYYY: '15/12/2023' o '15/12/2023 14:00'",
        "MM/DD/YYYY: '12/15/2023' o '12/15/2023 14:00'",
        "YYYY-MM-DD: '2023-12-15' o '2023-12-15 14:00'",
        "Timestamp Unix: 1702644000 (segundos) o 1702644000000 (milisegundos)",
        "Formatos nativos de JavaScript: 'Dec 15, 2023', 'December 15, 2023'"
      ],
      timezone_handling: {
        "with_timezone": "Las fechas con información de timezone (ej: -06:00, +02:00) se preservan exactamente como se envían",
        "utc_dates": "Las fechas UTC (con Z) se preservan tal como están",
        "local_dates": "Las fechas sin timezone se interpretan como UTC",
        "other_formats": "Otros formatos se convierten a UTC"
      },
      note: "Si no se puede parsear la fecha, se omitirá del registro para evitar errores"
    },
    automatic_fields: {
      "user_id": "Se obtiene automáticamente del lead si no se especifica",
      "site_id": "Se obtiene automáticamente del lead si no se especifica"
    },
    example_request: {
      title: "Seguimiento de lead",
      description: "Llamar al cliente para confirmar interés",
      type: "call",
      priority: 10,
      lead_id: "abcdef12-3456-7890-abcd-ef1234567890",
      scheduled_date: "15/12/2023 14:00", // Formato flexible
      amount: 1500.00,
      notes: "Cliente muy interesado en el producto enterprise",
      address: {
        street: "123 Main St",
        city: "Ciudad",
        country: "México"
      }
    },
    example_response: {
      success: true,
      task: {
        id: "task_123456",
        title: "Seguimiento de lead",
        description: "Llamar al cliente para confirmar interés",
        type: "call",
        status: "pending",
        stage: "pending",
        priority: 10,
        user_id: "12345678-1234-1234-1234-123456789012", // Obtenido del lead
        site_id: "87654321-4321-4321-4321-210987654321", // Obtenido del lead
        lead_id: "abcdef12-3456-7890-abcd-ef1234567890",
        scheduled_date: "2023-12-15T14:00:00.000Z", // Convertido a ISO 8601
        notes: "Cliente muy interesado en el producto enterprise",
        amount: 1500.00,
        address: {
          street: "123 Main St",
          city: "Ciudad",
          country: "México"
        },
        created_at: "2023-12-10T10:30:00Z",
        updated_at: "2023-12-10T10:30:00Z"
      }
    }
  });
} 