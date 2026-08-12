import { NextRequest, NextResponse } from 'next/server';
import { handleItemAction } from './handlers/items';
import { handleModifierAction } from './handlers/modifiers';

type ModifierResource = 'modifier_group' | 'modifier_group_item' | 'item_modifier_group';

function isModifierResource(resource: string): resource is ModifierResource {
  return (
    resource === 'modifier_group' ||
    resource === 'modifier_group_item' ||
    resource === 'item_modifier_group'
  );
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

    return NextResponse.json(
      {
        success: false,
        error:
          'Invalid resource. Use item, modifier_group, modifier_group_item, or item_modifier_group',
      },
      { status: 400 }
    );
  } catch (error: any) {
    console.error('Catalog Commerce tool error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
