// Lets a mod ask register.tsx for an early tick (the timer is an adaptive `after` chain, not a fixed 1 s interval).
export const sched: { wakeFn: () => void; wake: () => void } = {
  wakeFn: () => undefined,
  wake() {
    this.wakeFn()
  },
}
