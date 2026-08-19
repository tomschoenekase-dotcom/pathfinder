const RETIRED_VISIBLE_BRAND_PATTERN = /pathfinder|torchico/gi

/**
 * Keeps immutable historical records readable without leaking retired product names into the UI.
 */
export function normalizeTorchikoBrandText(value: string): string {
  return value.replace(RETIRED_VISIBLE_BRAND_PATTERN, 'Torchiko')
}
