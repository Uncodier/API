import { NextRequest, NextResponse } from 'next/server';
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
    console.error('Catalog Commerce tool error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
