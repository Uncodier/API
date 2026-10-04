import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSalesOrdersCore } from './core';

/**
 * POST endpoint to get sales orders with filters
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = await getSalesOrdersCore(body);
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    console.error('[GetSalesOrders] Error:', error);
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: 'Invalid filters', details: error.errors }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * GET endpoint for documentation
 */
export async function GET() {
  return NextResponse.json({
    message: "Sales Orders query API",
    usage: "Send a POST request with filters",
    filters: ["customer_id", "sale_id", "site_id", "status", "limit", "offset"]
  });
}