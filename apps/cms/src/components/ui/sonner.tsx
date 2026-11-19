import type { CSSProperties } from 'react';
import { Toaster as Sonner, type ToasterProps } from 'sonner';
import { useAppStore } from '~/state/provider';

const style: CSSProperties & Record<`--${string}`, string> = {
  '--normal-bg': 'var(--popover)',
  '--normal-text': 'var(--popover-foreground)',
  '--normal-border': 'var(--border)',
};

/** A toast's second line in the app's muted text token, which reads at 4.5:1 in both themes; sonner's own grey does not on the dark popover. */
const toastOptions: ToasterProps['toastOptions'] = { classNames: { description: 'text-muted-foreground!' } };

/** Toasts, in the app's theme. Results of tools run from the command menu, and publishes, show here. */
export function Toaster(props: ToasterProps) {
  const theme = useAppStore((s) => s.ui.theme);
  return <Sonner theme={theme} className="toaster group" style={style} toastOptions={toastOptions} {...props} />;
}
