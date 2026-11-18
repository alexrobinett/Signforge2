import type { CSSProperties } from 'react';
import { Toaster as Sonner, type ToasterProps } from 'sonner';
import { useAppStore } from '~/state/provider';

const style: CSSProperties & Record<`--${string}`, string> = {
  '--normal-bg': 'var(--popover)',
  '--normal-text': 'var(--popover-foreground)',
  '--normal-border': 'var(--border)',
};

/** Toasts, in the app's theme. Results of tools run from the command menu show here. */
export function Toaster(props: ToasterProps) {
  const theme = useAppStore((s) => s.ui.theme);
  return <Sonner theme={theme} className="toaster group" style={style} {...props} />;
}
