/** What a publish changed, in words (#370): each name its own, in <bdi>, and a long one breaks rather than spills. */
import { Fragment } from 'react';
import { changeParts, type PublishView } from '~/lib/publishes';

/** Names in a sentence, each in <bdi>: "A, B and C", or "A, B and 4 more". */
function Named({ names, more }: { names: readonly string[]; more: number }) {
  const items = [...names.map((n) => <bdi key={`n-${n}`}>{n}</bdi>), ...(more ? [<Fragment key="more">{more.toLocaleString()} more</Fragment>] : [])];
  return items.map((item, i) => (
    <Fragment key={item.key}>
      {i === 0 ? '' : i === items.length - 1 ? ' and ' : ', '}
      {item}
    </Fragment>
  ));
}

export function PublishChanges({ id, changes }: { id: string; changes: NonNullable<PublishView['changes']> }) {
  const parts = changeParts(changes);
  return (
    <span id={id} className="min-w-0 wrap-anywhere">
      {parts.length
        ? parts.map((p, i) => (
            <Fragment key={`${p.lead}-${p.tail}`}>
              {i ? '; ' : ''}
              {i ? p.lead : `${p.lead.charAt(0).toUpperCase()}${p.lead.slice(1)}`} <Named names={p.names} more={p.more} />
              {p.tail ? ` ${p.tail}` : ''}
            </Fragment>
          ))
        : 'No draft changed: the screens were compiled again'}
    </span>
  );
}
