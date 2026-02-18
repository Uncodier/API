import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';

const CreateSaleSchema = z.object({
  customer_id: z.string().uuid(),
  product_ids: z.array(z.string().uuid()),
  payment_method: z.string(),
  total_amount: z.number().positive(),
  status: z.string().optional().default('completed'),
  notes: z.string().optional(),
  discount: z.number().optional(),
  tax: z.number().optional(),
  shipping_address: z.record(z.unknown()).optional(),
  site_id: z.string().uuid('Site ID is required'),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const validatedData = CreateSaleSchema.parse(body);
    const { customer_id, product_ids, site_id, ...saleDetails } = validatedData;

    // Verificar que el cliente existe y pertenece al sitio
    const { data: customer, error: customerError } = await supabaseAdmin
      .from('customers')
      .select('site_id')
      .eq('id', customer_id)
      .single();

    if (customerError || !customer) {
      return NextResponse.json({ success: false, error: 'Customer not found' }, { status: 404 });
    }

    if (customer.site_id !== site_id) {
      return NextResponse.json({ success: false, error: 'El cliente no pertenece a este sitio' }, { status: 403 });
    }

    const sale_id = uuidv4();
    const now = new Date().toISOString();

    const { data: sale, error: saleError } = await supabaseAdmin
      .from('sales')
      .insert([{
        id: sale_id,
        customer_id,
        product_ids,
        site_id: finalSiteId,
        created_at: now,
        updated_at: now,
        ...saleDetails
      }])
      .select()
      .single();

    if (saleError) {
      console.error('Error creating sale:', saleError);
      return NextResponse.json({ success: false, error: 'Failed to create sale' }, { status: 500 });
    }

    // Create sale items
    const { data: products } = await supabaseAdmin
      .from('products')
      .select('id, name, price')
      .in('id', product_ids);

    if (products && products.length > 0) {
      const saleItems = products.map(p => ({
        id: uuidv4(),
        sale_id,
        product_id: p.id,
        product_name: p.name,
        price: p.price,
        quantity: 1,
        created_at: now,
        updated_at: now
      }));

      await supabaseAdmin.from('sale_items').insert(saleItems);
    }

    return NextResponse.json({ success: true, sale }, { status: 201 });

  } catch (error) {
    console.error('[CreateSale] Error:', error);
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: 'Invalid data', details: error.errors }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
