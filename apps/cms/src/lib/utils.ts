import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/** tailwind-merge with the CMS's own type steps (src/styles.css): else it reads `text-meta` as a colour and drops one of the two (#372). */
const twMerge = extendTailwindMerge({ extend: { classGroups: { 'font-size': [{ text: ['2xs', 'meta', 'md'] }] } } });

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
