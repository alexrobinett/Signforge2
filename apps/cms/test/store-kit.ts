// What the store tests of a slice whose tools are stubbed share: the org they act in, a Query client
// whose invalidations are watched, and the toasts as sonner holds them.
import { QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { vi } from 'vitest';

export const ORG = 'org_1';

/** A Query client, and the invalidations made on it. */
export function watchedQueries() {
  const queryClient = new QueryClient();
  return { queryClient, invalidated: vi.spyOn(queryClient, 'invalidateQueries') };
}

/** The toast titled `title` as sonner holds it. */
export const toastTitled = (title: string) => toast.getToasts().find((t) => 'title' in t && t.title === title);
