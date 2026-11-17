import { defineTemplate } from '@signforge/template-sdk';

interface Item {
  name: string;
  description: string;
  price: string;
  tag: string;
}

defineTemplate({
  prepare(ctx) {
    const stage = document.getElementById('stage')!;
    document.documentElement.style.setProperty('--accent', String(ctx.data.accent));
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
  },
});
