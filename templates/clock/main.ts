import { defineTemplate, formatter, type TemplateContext } from '@signforge/template-sdk';

let timer = 0;

function render(ctx: TemplateContext): void {
  const now = new Date();
  const h24 = Boolean(ctx.data.hour24);
  const parts = formatter(ctx, { hour: 'numeric', minute: '2-digit', second: '2-digit', hourCycle: h24 ? 'h23' : 'h12' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  set('hm', `${get('hour')}:${get('minute')}`);
  set('sec', ctx.data.seconds ? `:${get('second')}` : '');
  set('ampm', h24 ? '' : get('dayPeriod'));
  set('date', formatter(ctx, { weekday: 'long', month: 'long', day: 'numeric' }).format(now));
  const hour = Number(formatter(ctx, { hour: 'numeric', hourCycle: 'h23' }).format(now));
  const auto = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  set('greeting', String(ctx.data.greeting || auto));
}

function set(id: string, text: string): void {
  const el = document.getElementById(id)!;
  if (el.textContent !== text) el.textContent = text;
}

defineTemplate({
  prepare(ctx) {
    document.documentElement.style.setProperty('--accent', String(ctx.data.accent));
    render(ctx);
  },
  play(ctx) {
    // Wake on each second boundary; text only changes when the value does.
    const tick = () => {
      render(ctx);
      timer = window.setTimeout(tick, 1000 - (Date.now() % 1000) + 5);
    };
    tick();
  },
  stop() {
    clearTimeout(timer);
  },
});
