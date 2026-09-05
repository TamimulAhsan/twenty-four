/**
 * The shell every merchant-plane application boots into.
 *
 * Each application is now its own build, image and deployment, so anything all
 * of them need lives here rather than being copied four times. Keeping boot
 * and the session gate identical across applications is what makes launching
 * the till from the dashboard feel like one product rather than four.
 */
export { boot } from './boot'
export { SessionGate } from './SessionGate'
export { DevToolbar } from './DevToolbar'
export { CatalogList } from './CatalogList'
export { CatalogItemDialog } from './CatalogItemDialog'
export { TeamList } from './TeamList'
export {
  useOrderRefund,
  RefundActions,
  RefundCheckbox,
  RefundConfirmation,
  RefundHint,
  type OrderRefund,
  type RefundKind,
} from './refund'
