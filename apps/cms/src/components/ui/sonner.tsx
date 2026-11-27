import type { CSSProperties } from 'react';
import { Toaster as Sonner, type ToasterProps } from 'sonner';
import { useAppStore } from '~/state/provider';

const style: CSSProperties & Record<`--${string}`, string> = {
  '--normal-bg': 'var(--popover)',
  '--normal-text': 'var(--popover-foreground)',
  '--normal-border': 'var(--border)',
  '--width': '440px',
};

/**
 * The kit's toast (canvas kit, Toast and dialog): dark in both themes, a 15 px title, the actions
 * under the words, the main one first as a button and the other as a link. Its colours are the
 * `toast` tokens, each checked at 4.5:1 or more on its background (test/tokens.test.ts).
 */
const toastOptions: ToasterProps['toastOptions'] = {
  classNames: {
    toast: 'flex-wrap! items-start! gap-x-2.5! gap-y-3! bg-toast! text-toast-foreground! border-toast-edge!',
    title: 'text-md! font-semibold! text-toast-foreground!',
    description: 'text-toast-muted-foreground!',
    content: 'basis-[calc(100%-2rem)]',
    actionButton: 'order-1 h-9! px-3.5! text-sm! font-semibold! bg-toast-action! text-toast-action-foreground! ml-8!',
    cancelButton: 'order-2 h-9! bg-transparent! text-sm! text-toast-link! underline! underline-offset-4!',
  },
};

/** Toasts, in the app's theme. Results of tools run from the command menu, and publishes, show here. */
export function Toaster(props: ToasterProps) {
  const theme = useAppStore((s) => s.ui.theme);
  return <Sonner theme={theme} className="toaster group" style={style} toastOptions={toastOptions} {...props} />;
}
