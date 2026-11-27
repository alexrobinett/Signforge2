import { defineTemplate } from '@signforge/template-sdk';
import { bindRow } from '@signforge/template-sdk/rows';

defineTemplate({
  prepare(ctx) {
    const items = ctx.data.items;
    const count = Array.isArray(items) ? items.length : 0;
    bindRow(document.getElementById('lead')!, ctx, 'items', 0);
    const rest = document.getElementById('rest')!;
    for (let i = 1; i < count; i++) {
      const li = document.createElement('li');
      li.innerHTML = '<img data-sf-src="image:thumb" alt=""><span data-sf="title"></span>';
      bindRow(li, ctx, 'items', i);
      rest.append(li);
    }
  },
});
