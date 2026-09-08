/**
 * The icon set.
 *
 * Lucide, one family, one stroke weight, on a 24px grid. Registered explicitly
 * rather than imported wholesale so the bundle carries what is used and a typo
 * in an icon name is a compile error rather than a blank square.
 *
 * Emoji are never icons here. They render differently on every platform, cannot
 * be themed, and cannot take a stroke weight.
 */
import {
  AlertCircle, AlertTriangle, ArrowLeft, ArrowRight, ArrowUpRight, Ban, Bell, Boxes,
  Building2, Calendar, CalendarDays, Check, CheckCircle2, ChefHat, ChartNoAxesCombined,
  ChevronDown,
  ChevronLeft, ChevronRight, ChevronsUpDown, CircleDot, Clock, Contact, CreditCard,
  Ellipsis, ExternalLink, Eye, EyeOff, FileClock, FileText, Filter, Gauge, Globe, Grid3x3,
  Info, KeyRound, Layers,
  LayoutDashboard, LayoutGrid, LoaderCircle, LogOut, Megaphone, Menu, Minus, Moon, Package,
  Pencil, Percent,
  Plus, Printer, Receipt, ReceiptText, RefreshCw, RotateCcw, Search, ScanLine, Settings,
  ShieldAlert, ShieldCheck, Sparkles, Sun, Trash2, TrendingDown, TrendingUp, TriangleAlert,
  User, UserCog, Users,
  Wallet, X, type LucideIcon,
} from 'lucide-react'

export const icons = {
  AlertCircle, AlertTriangle, ArrowLeft, ArrowRight, ArrowUpRight, Ban, Bell, Boxes,
  Building2, Calendar, CalendarDays, Check, CheckCircle2, ChefHat, ChartNoAxesCombined,
  ChevronDown,
  ChevronLeft, ChevronRight, ChevronsUpDown, CircleDot, Clock, Contact, CreditCard,
  Ellipsis, ExternalLink, Eye, EyeOff, FileClock, FileText, Filter, Gauge, Globe, Grid3x3,
  Info, KeyRound, Layers,
  LayoutDashboard, LayoutGrid, LoaderCircle, LogOut, Megaphone, Menu, Minus, Moon, Package,
  Pencil, Percent,
  Plus, Printer, Receipt, ReceiptText, RefreshCw, RotateCcw, Search, ScanLine, Settings,
  ShieldAlert, ShieldCheck, Sparkles, Sun, Trash2, TrendingDown, TrendingUp, TriangleAlert,
  User, UserCog, Users,
  Wallet, X,
} satisfies Record<string, LucideIcon>

export type IconName = keyof typeof icons

/** Sizes are tokens, not arbitrary numbers, so icons keep a rhythm. */
export const iconSize = { sm: 14, md: 16, lg: 20, xl: 24 } as const
export type IconSize = keyof typeof iconSize

export interface IconProps {
  name: IconName
  size?: IconSize
  className?: string
  /** Set only when the icon is the sole carrier of meaning. Decorative icons
   *  beside a text label stay hidden from assistive technology. */
  label?: string
}

export function Icon({ name, size = 'md', className, label }: IconProps) {
  const Component = icons[name]
  return (
    <Component
      size={iconSize[size]}
      strokeWidth={1.75}
      className={className}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? 'img' : undefined}
      focusable="false"
    />
  )
}

export function isIconName(value: string): value is IconName {
  return value in icons
}
