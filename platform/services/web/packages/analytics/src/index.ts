export {
  presetPeriod,
  previousPeriod,
  dayCount,
  eachDay,
  containsDay,
  change,
  type Period,
  type PeriodPreset,
} from './period'

export {
  isTrading,
  day,
  sumBy,
  marginOf,
  type AnalysedLine,
  type AnalysedOrder,
} from './types'

export {
  productPerformance,
  basketAffinity,
  medianOf,
  performanceThresholds,
  VERDICT_LABELS,
  type ProductPerformance,
  type ProductPerformanceInput,
  type ProductVerdict,
  type AbcClass,
  type BasketPair,
} from './products'

export {
  customerMetrics,
  segmentSummary,
  cohorts,
  SEGMENTS,
  type CustomerMetrics,
  type Segment,
  type SegmentSummary,
  type Cohort,
  type CustomerAnalysisInput,
} from './customers'

export { discountPerformance, type DiscountPerformance } from './discounts'

export {
  revenueByDay,
  hourlyHeatmap,
  financialSummary,
  revenueBy,
  type DayPoint,
  type HeatCell,
  type FinancialSummary,
} from './timeseries'
