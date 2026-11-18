/**
 * `identify` from the CMS: the screen's name, large, over its content for a few seconds, inside a
 * bright frame, so someone in the room can tell which screen is which. Static: nothing animates,
 * and it draws only while asked, never during normal playback.
 */
let timer: ReturnType<typeof setTimeout> | undefined;

export function identify(name: string, seconds: number): void {
  const el = document.getElementById('identify') ?? document.body.appendChild(Object.assign(document.createElement('div'), { id: 'identify' }));
  const card = Object.assign(document.createElement('div'), { className: 'card' });
  card.append(
    Object.assign(document.createElement('div'), { className: 'label', textContent: 'This screen is' }),
    Object.assign(document.createElement('div'), { className: 'name', textContent: name }),
  );
  el.replaceChildren(card);
  el.style.display = 'grid';
  clearTimeout(timer);
  timer = setTimeout(() => (el.style.display = 'none'), seconds * 1000);
}
