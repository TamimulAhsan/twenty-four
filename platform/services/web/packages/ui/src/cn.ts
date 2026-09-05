import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Merges class lists so a caller's className wins over a component default
 *  instead of both landing in the markup and the cascade deciding. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
