import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

/**
 * Endpoint para crear un registro de venta y opcionalmente una orden de venta
 * 
 * @param request Solicitud entrante con los datos de la venta
 * @returns Respuesta con los detalles de la venta creada
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    
    // Extraer parámetros requeridos
    const { 
      customer_id,
      site_id,
      product_ids,
      payment_method,
      total_amount,
      create_order = false,
      status = 'pending',
      notes,
      discount,
      tax,
      shipping_address,
      order_details
    } = body;
    
    // Validar parámetros requeridos
    if (!customer_id || !site_id) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'customer_id and site_id are required'
        },
        { status: 400 }
      );
    }
    
    if (!isValidUUID(customer_id) || !isValidUUID(site_id)) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'customer_id and site_id must be valid UUIDs'
        },
        { status: 400 }
      );
    }
    
    if (!product_ids || !Array.isArray(product_ids) || product_ids.length === 0) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'product_ids must be a non-empty array'
        },
        { status: 400 }
      );
    }
    
    // Validar que todos los product_ids sean UUID válidos
    for (const productId of product_ids) {
      if (!isValidUUID(productId)) {
        return NextResponse.json(
          { 
            success: false, 
            error: `Product ID ${productId} is not a valid UUID`
          },
          { status: 400 }
        );
      }
    }
    
    if (!payment_method) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'payment_method is required'
        },
        { status: 400 }
      );
    }
    
    if (total_amount === undefined || total_amount <= 0) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'total_amount must be a positive number'
        },
        { status: 400 }
      );
    }
    
    // Validar order_details si create_order es true
    if (create_order && !order_details) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'order_details is required when create_order is true'
        },
        { status: 400 }
      );
    }
    
    // Verificar que el cliente existe
    const { data: customerData, error: customerError } = await supabaseAdmin
      .from('customers')
      .select('id, name, email, site_id')
      .eq('id', customer_id)
      .single();
    
    if (customerError) {
      console.error('Error al verificar el cliente:', customerError);
      return NextResponse.json(
        { 
          success: false, 
          error: 'Customer not found'
        },
        { status: 404 }
      );
    }

    if (customerData.site_id !== site_id) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'El cliente no pertenece a este sitio'
        },
        { status: 403 }
      );
    }
    
    // Verificar que todos los productos existen
    const { data: productsData, error: productsError } = await supabaseAdmin
      .from('products')
      .select('id, name, price')
      .in('id', product_ids);
    
    if (productsError) {
      console.error('Error al verificar los productos:', productsError);
      return NextResponse.json(
        { 
          success: false, 
          error: 'Error checking products'
        },
        { status: 500 }
      );
    }
    
    if (!productsData || productsData.length !== product_ids.length) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'One or more products not found'
        },
        { status: 404 }
      );
    }
    
    // Crear venta
    const sale_id = uuidv4();
    const now = new Date().toISOString();
    
    const saleData = {
      id: sale_id,
      customer_id,
      product_ids,
      payment_method,
      total_amount,
      status,
      notes,
      discount,
      tax,
      shipping_address,
      created_at: now,
      updated_at: now,
      site_id: customerData.site_id
    };
    
    const { data: sale, error: saleError } = await supabaseAdmin
      .from('sales')
      .insert([saleData])
      .select()
      .single();
    
    if (saleError) {
      console.error('Error al crear la venta:', saleError);
      return NextResponse.json(
        { 
          success: false, 
          error: 'Failed to create sale'
        },
        { status: 500 }
      );
    }
    
    // Crear orden de venta si se solicita
    let order = null;
    if (create_order) {
      const order_id = uuidv4();
      
      const orderData = {
        id: order_id,
        sale_id,
        customer_id,
        products: productsData,
        delivery_date: order_details.delivery_date,
        shipping_method: order_details.shipping_method,
        priority: order_details.priority || 'medium',
        status: 'pending',
        shipping_address: shipping_address || null,
        created_at: now,
        updated_at: now,
        site_id: customerData.site_id
      };
      
      const { data: orderResult, error: orderError } = await supabaseAdmin
        .from('orders')
        .insert([orderData])
        .select()
        .single();
      
      if (orderError) {
        console.error('Error al crear la orden:', orderError);
        // No fallamos toda la operación si solo falla la orden
        console.log('Continuando con la respuesta de la venta...');
      } else {
        order = orderResult;
      }
    }
    
    // Crear líneas de producto para la venta
    const saleItems = productsData.map(product => ({
      id: uuidv4(),
      sale_id,
      product_id: product.id,
      product_name: product.name,
      price: product.price,
      quantity: 1, // Por defecto asumimos cantidad 1 por producto
      created_at: now,
      updated_at: now
    }));
    
    const { error: itemsError } = await supabaseAdmin
      .from('sale_items')
      .insert(saleItems);
    
    if (itemsError) {
      console.error('Error al crear los items de la venta:', itemsError);
      // No fallamos toda la operación si solo fallan los items
      console.log('Continuando con la respuesta de la venta...');
    }
    
    // Respuesta exitosa
    return NextResponse.json(
      {
        success: true,
        sale: {
          id: sale.id,
          customer_id: sale.customer_id,
          product_ids: sale.product_ids,
          payment_method: sale.payment_method,
          total_amount: sale.total_amount,
          status: sale.status,
          created_at: sale.created_at
        },
        order: order ? {
          id: order.id,
          delivery_date: order.delivery_date,
          shipping_method: order.shipping_method,
          priority: order.priority,
          status: order.status
        } : null,
        items: productsData.map(p => ({
          product_id: p.id,
          name: p.name,
          price: p.price
        }))
      },
      { status: 201 }
    );
    
  } catch (error) {
    console.error('Error al procesar la creación de venta:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: 'Error processing sale creation request'
      },
      { status: 500 }
    );
  }
}
