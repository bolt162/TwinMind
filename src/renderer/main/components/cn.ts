/**
 * `cn` — small utility for merging Tailwind class lists.
 *
 * Wraps clsx + tailwind-merge so component code can write
 * `cn('p-4', isActive && 'bg-zinc-800', className)` and get a single sane
 * className without dup utilities.
 */

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
