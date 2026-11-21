import { defineTemplate } from '@signforge/template-sdk';

defineTemplate({
  prepare(ctx) {
    document.getElementById('weather')!.textContent = `${String(ctx.data.city)} ${Math.round(Number(ctx.data.temp))}${String(ctx.data.unit)}`;
    const items: unknown = ctx.data.items;
    const titles = Array.isArray(items) ? items.map((i: { title?: unknown }) => String(i.title)) : [];
    document.getElementById('headlines')!.replaceChildren(
      ...titles.map((t) => {
        const li = document.createElement('li');
        li.textContent = t;
        return li;
      }),
    );
  },
});
