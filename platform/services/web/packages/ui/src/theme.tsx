import { useCallback, useEffect, useState } from 'react'
import {
  applyTheme,
  readThemePreference,
  resolveTheme,
  writeThemePreference,
  type ThemePreference,
} from '@twentyfour/tokens'
import { cn } from './cn'
import { Icon } from './icon'

/**
 * Light, dark or follow the system.
 *
 * Three states, not two. A toggle that only flips between light and dark takes
 * away the setting most people already made once, on their device.
 */
export function useThemePreference() {
  const [preference, setPreference] = useState<ThemePreference>(() => readThemePreference())

  useEffect(() => {
    applyTheme(resolveTheme(preference))
    if (preference !== 'system') return
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applyTheme(resolveTheme('system'))
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [preference])

  const update = useCallback((next: ThemePreference) => {
    writeThemePreference(next)
    setPreference(next)
  }, [])

  return { preference, setPreference: update }
}

const OPTIONS: Array<{ value: ThemePreference; label: string; icon: 'Sun' | 'Moon' | 'CircleDot' }> = [
  { value: 'light', label: 'Light', icon: 'Sun' },
  { value: 'dark', label: 'Dark', icon: 'Moon' },
  { value: 'system', label: 'System', icon: 'CircleDot' },
]

export function ThemeToggle({ className }: { className?: string }) {
  const { preference, setPreference } = useThemePreference()
  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className={cn('inline-flex rounded-lg bg-surface-sunken p-0.5', className)}
    >
      {OPTIONS.map((option) => {
        const active = preference === option.value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={option.label}
            onClick={() => setPreference(option.value)}
            className={cn(
              'inline-flex h-8 w-8 items-center justify-center rounded-md',
              'transition-colors duration-[var(--duration-fast)]',
              'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring',
              active
                ? 'bg-surface text-text shadow-[var(--shadow-xs)]'
                : 'text-text-subtle hover:text-text',
            )}
          >
            <Icon name={option.icon} size="md" />
            <span className="sr-only">{option.label}</span>
          </button>
        )
      })}
    </div>
  )
}
