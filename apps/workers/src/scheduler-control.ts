export interface SchedulerControl {
  upsert: () => Promise<unknown>
  remove: () => Promise<unknown>
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
