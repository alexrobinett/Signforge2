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
    // The tags' fill is the spot's accent, which need not be the kit's, and their text without a
    // kit is the theme's background, light in the light theme: the text is chosen against the fill.
    const style = getComputedStyle(stage);
    stage.style.setProperty('--on-accent', readableOn(accent, style.getPropertyValue('--on-accent')));
    // Prices are the accent on the theme's background: amber, for one, does not read on a light one.
    stage.style.setProperty('--accent-text', readableOn(style.getPropertyValue('--bg'), accent));
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
  },
});
