import { defineTemplate } from '@signforge/template-sdk';
import { readableOn } from '@signforge/template-sdk/contrast';

interface Item {
  name: string;
  description: string;
  price: string;
  tag: string;
}

defineTemplate({
  prepare(ctx) {
    const stage = document.getElementById('stage')!;
    const accent = String(ctx.data.accent);
    document.documentElement.style.setProperty('--accent', accent);
    if (ctx.data.theme === 'light') stage.classList.add('light');
    const items = (ctx.data.items as Item[]) ?? [];
    // A short menu reads better as one centred column.
    if (items.length <= 5) stage.classList.add('one-col');
    const list = document.getElementById('items')!;
    const tpl = document.getElementById('row') as HTMLTemplateElement;
    items.forEach((it, i) => {
      const li = tpl.content.firstElementChild!.cloneNode(true) as HTMLElement;
      li.style.setProperty('--i', String(i));
      li.querySelector('.name')!.textContent = it.name;
      li.querySelector('.tag')!.textContent = it.tag;
      li.querySelector('.price')!.textContent = it.price;
      li.querySelector('.desc')!.textContent = it.description;
      list.appendChild(li);
    });
    // Tags are the accent on the theme's background: amber, for one, does not read on the light one. They are large
    // text at 1080p (2.6vmin, 28 px), where 3:1 reads.
    stage.style.setProperty('--accent-text', readableOn(getComputedStyle(stage).getPropertyValue('--bg'), accent, { large: true }));
  },
});
