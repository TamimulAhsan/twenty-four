/**
 * The handful of tokens JavaScript needs to agree with CSS about.
 *
 * Everything visual lives in theme.css. What is duplicated here is only what
 * code has to reason about at runtime: breakpoints for layout decisions,
 * durations for timers that must outlast an animation, and the theme switch.
 */

/** Matches --breakpoint-* in theme.css. Values are px. */
export const breakpoints = {
  xs: 360,
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  '2xl': 1536,
} as const

export type Breakpoint = keyof typeof breakpoints

/** Matches --duration-* in theme.css. Values are ms. */
export const durations = {
  fast: 120,
  base: 180,
  slow: 260,
  exit: 120,
} as const

export const zIndex = {
  sticky: 10,
  dropdown: 20,
  overlay: 40,
  modal: 50,
  popover: 60,
  toast: 100,
} as const

/**
 * The smallest touch target the product ships, in px.
 * Apple asks for 44, Material for 48. 44 is the floor; anything a finger
 * uses often (till keys, calendar slots) is given more.
 */
export const MIN_TOUCH_TARGET = 44

/* -------------------------------------------------------------------------
 * Theme
 * ---------------------------------------------------------------------- */

export type ThemePreference = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

const STORAGE_KEY = 'tf.theme'

export function prefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference === 'system') return prefersDark() ? 'dark' : 'light'
  return preference
}

export function readThemePreference(): ThemePreference {
  if (typeof localStorage === 'undefined') return 'system'
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
  } catch {
    // Private windows and blocked site data both throw on read. Defaulting to
    // "system" is correct in either case, so there is nothing to report.
  }
  return 'system'
}

export function writeThemePreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, preference)
  } catch {
    // Preference is a convenience, not state the product depends on.
  }
}

/** Applies a resolved theme to <html>. The only writer of the `dark` class. */
export function applyTheme(theme: ResolvedTheme): void {
  const root = document.documentElement
  root.classList.toggle('dark', theme === 'dark')
  root.style.colorScheme = theme
}

/**
 * Inlined into index.html before first paint. Anything that reads the theme
 * after React mounts produces a flash of the wrong palette on every load.
 */
export const themeBootScript = `(function(){try{var p=localStorage.getItem('${STORAGE_KEY}')||'system';var d=p==='dark'||(p==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);document.documentElement.style.colorScheme=d?'dark':'light'}catch(e){}})()`
