import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  PromotionError,
  createPromotion,
  deletePromotion,
  getPromotion,
  listPromotions,
  updatePromotion,
} from '@/lib/promotions/crud';

function isPromotionError(error: unknown): error is PromotionError {
  if (error instanceof PromotionError) return true;
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: string; statusCode?: number };
  return candidate.name === 'PromotionError' && typeof candidate.statusCode === 'number';
}

function errorResponse(error: unknown) {
  if (isPromotionError(error)) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: error.statusCode }
    );
  }
  if (error instanceof z.ZodError) {
    const first = error.issues[0];
    return NextResponse.json(
      { success: false, error: first?.message || 'Invalid data', details: error.issues },
      { status: 400 }
    );
  }
  const message = error instanceof Error ? error.message : 'Internal server error';
  console.error('Promotions tool error:', error);
  return NextResponse.json({ success: false, error: message }, { status: 500 });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, promotion_id, ...rest } = body || {};
    const id = rest.id || promotion_id;

    if (!action) {
      return NextResponse.json({ success: false, error: 'Missing action' }, { status: 400 });
    }

    if (action === 'list') {
      const result = await listPromotions(rest);
      return NextResponse.json({ success: true, ...result });
    }

    if (action === 'get') {
      const result = await getPromotion({ ...rest, id });
      return NextResponse.json({ success: true, ...result });
    }

    if (action === 'create') {
      const result = await createPromotion(rest);
      return NextResponse.json({ success: true, ...result }, { status: 201 });
    }

    if (action === 'update') {
      const result = await updatePromotion({ ...rest, id });
      return NextResponse.json({ success: true, ...result });
    }

    if (action === 'delete') {
      const result = await deletePromotion({ ...rest, id });
      return NextResponse.json({ success: true, ...result });
    }

    return NextResponse.json({ success: false, error: 'Invalid action' }, { status: 400 });
  } catch (error) {
    return errorResponse(error);
  }
}
