import React from 'react';
import { z } from 'zod';
import { ApiEndpoint } from '../types';
import { DatePicker } from '@/components/ui/date-picker';

const EmailApiSchema = z.object({
  site_id: z.string().min(1, "Site ID is required"),
  limit: z.number().default(10).optional(),
  lead_id: z.string().optional(),
  agentId: z.string().optional(),
  user_id: z.string().optional(),
  team_member_id: z.string().optional(),
  analysis_type: z.string().optional(),
  since_date: z.string().optional(),
});

type EmailApiType = z.infer<typeof EmailApiSchema>;

const defaultValues: EmailApiType = {
  site_id: "",
  limit: 10,
  lead_id: undefined,
  agentId: undefined,
  user_id: undefined,
  team_member_id: undefined,
  analysis_type: undefined,
  since_date: undefined,
};

export const emailEndpoints: ApiEndpoint<EmailApiType>[] = [
  {
    name: "Analizar Emails",
    description: "Obtiene y analiza emails del buzón configurado",
    method: "POST",
    path: "/api/agents/email",
    schema: EmailApiSchema,
    defaultValues,
    renderForm: ({ register, control, errors }) => (
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">Site ID</label>
          <input
            type="text"
            className="w-full p-2 border rounded"
            {...register("site_id")}
          />
          {errors.site_id && (
            <p className="text-red-500 text-sm">{errors.site_id.message}</p>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Límite de emails</label>
          <input
            type="number"
            className="w-full p-2 border rounded"
            {...register("limit", { valueAsNumber: true })}
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Desde fecha (opcional)</label>
          <DatePicker
            {...register("since_date")}
            control={control}
            placeholder="Selecciona una fecha"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Lead ID (opcional)</label>
          <input
            type="text"
            className="w-full p-2 border rounded"
            {...register("lead_id")}
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Agent ID (opcional)</label>
          <input
            type="text"
            className="w-full p-2 border rounded"
            {...register("agentId")}
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">User ID (opcional)</label>
          <input
            type="text"
            className="w-full p-2 border rounded"
            {...register("user_id")}
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Team Member ID (opcional)</label>
          <input
            type="text"
            className="w-full p-2 border rounded"
            {...register("team_member_id")}
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Tipo de análisis (opcional)</label>
          <select
            className="w-full p-2 border rounded"
            {...register("analysis_type")}
          >
            <option value="">Seleccionar tipo</option>
            <option value="commercial">Comercial</option>
            <option value="support">Soporte</option>
            <option value="general">General</option>
          </select>
        </div>
      </div>
    ),
  },
]; 