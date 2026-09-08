/**
 * The shell every application boots into.
 *
 * Each application is its own build, image and deployment, so anything all of
 * them need lives here rather than being copied five times. Keeping boot
 * identical across applications is what makes launching the till from the
 * dashboard feel like one product rather than several.
 *
 * Everything below boot is merchant-plane: a session gate that redirects to
 * /auth, a dev toolbar that swaps tenant fixtures, catalog and team lists. The
 * admin console takes boot and nothing else, because it answers to a different
 * gateway and a different sign-in.
 */
export { boot, type BootOptions } from './boot'
export { SessionGate } from './SessionGate'
export { AUTH_PATH, signInUrl, useSignOut, SignOutButton } from './session'
export { DevToolbar } from './DevToolbar'
export { CatalogList } from './CatalogList'
export { CatalogItemDialog } from './CatalogItemDialog'
export { TeamList } from './TeamList'
export { BusinessTypeSelector } from './BusinessTypeSelector'
export {
  useOrderRefund,
  RefundActions,
  RefundCheckbox,
  RefundConfirmation,
  RefundHint,
  type OrderRefund,
  type RefundKind,
} from './refund'
