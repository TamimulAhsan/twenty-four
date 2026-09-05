import { useCallback, useEffect, useState } from 'react'

const KEY = 'tf.sidebar.collapsed'

/**
 * Whether the sidebar is showing icons only.
 *
 * Persisted, because it is a working preference rather than a navigation
 * state: someone who collapsed it to get more table on screen wants it
 * collapsed tomorrow too.
 */
export function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(KEY) === 'true'
    } catch {
      return false
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(KEY, String(collapsed))
    } catch {
      // A preference, not state the product depends on.
    }
  }, [collapsed])

  const toggle = useCallback(() => setCollapsed((value) => !value), [])
  return { collapsed, toggle }
}
