import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { authorizeCatalogRequest, CatalogAuthorizationError } from '@/lib/services/catalog-search/auth';
import { CatalogSearchChangedError } from '@/lib/services/catalog-search/service';
import { createCatalogToolSearchInput } from './handlers/catalog-search';
import { enforceRequestRateLimit } from '@/lib/security/request-rate-limit';
import { handleItemAction } from './handlers/items';
import { handleModifierAction } from './handlers/modifiers';
import { handleSpecsAction, SpecResource } from './handlers/specs';
import { handleTaxesAction, TaxResource } from './handlers/taxes';

type ModifierResource = 'modifier_group' | 'modifier_group_item' | 'item_modifier_group';

function isModifierResource(resource: string): resource is ModifierResource {
  return (
    resource === 'modifier_group' ||
    resource === 'modifier_group_item' ||
    resource === 'item_modifier_group'
  );
}

function isSpecResource(resource: string): resource is SpecResource {
  return (
    resource === 'item_spec_category' ||
    resource === 'item_spec' ||
    resource === 'catalog_item_spec'
  );
}

function isTaxResource(resource: string): resource is TaxResource {
  return resource === 'tax' || resource === 'catalog_item_tax';
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, resource = 'item' } = body;

    if (!action) {
      return NextResponse.json({ success: false, error: 'Missing action' }, { status: 400 });
    }

    if (resource === 'item') {
      if (action === 'list' && typeof body.search === 'string' && body.search.trim()) {
        const input = createCatalogToolSearchInput(body);
        const principal = await authorizeCatalogRequest(request, input);
        const denied = await enforceRequestRateLimit(request, {
          namespace: 'catalog-search', identity: principal.rateIdentity || principal.scope,
          limit: principal.aggregateOnly ? 600 : 180, windowSeconds: 60, failClosed: true,
        });
        if (denied) return denied;
        return await handleItemAction(body, principal);
      }
      return await handleItemAction(body);
    }

    if (isModifierResource(resource)) {
      return await handleModifierAction(resource, body);
    }

    if (isSpecResource(resource)) {
      return await handleSpecsAction(resource, body);
    }

    if (isTaxResource(resource)) {
      return await handleTaxesAction(resource, body);
    }

    return NextResponse.json(
      {
        success: false,
        error:
          'Invalid resource. Use item, modifier_group, modifier_group_item, item_modifier_group, tax, catalog_item_tax, item_spec_category, item_spec, or catalog_item_spec',
      },
      { status: 400 }
    );
  } catch (error: any) {
    if (error instanceof ZodError) {
      return NextResponse.json({ success: false, error: 'Invalid catalog parameters (site_id, filters, search or pagination)' }, { status: 400 });
    }
    if (error instanceof CatalogAuthorizationError) {
      return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    }
    if (error instanceof CatalogSearchChangedError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 409 });
    }
    console.error('Catalog Commerce tool error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
