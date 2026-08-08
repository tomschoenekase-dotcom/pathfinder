export interface SchedulerControl {
  upsert: () => Promise<unknown>
  remove: () => Promise<unknown>
}

export function utcCronSchedule(pattern: string): { pattern: string; tz: 'UTC' } {
  return { pattern, tz: 'UTC' }
}

export async function applySchedulerState(
  enabled: boolean,
  schedulers: SchedulerControl[],
): Promise<void> {
  for (const scheduler of schedulers) {
    if (enabled) {
      await scheduler.upsert()
    } else {
      await scheduler.remove()
    }
  }
}
