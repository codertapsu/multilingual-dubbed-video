import { describe, expect, it } from 'vitest';
import type { SystemProfile } from '@videodubber/shared';
import { effectiveCapacity, recommendCapacity } from './capacity.js';

function profile(o: Partial<SystemProfile> = {}): SystemProfile {
  return {
    platform: 'darwin',
    arch: 'arm64',
    cpuModel: 'test',
    cpuCores: 8,
    totalRamMb: 16384,
    freeRamMb: 4096,
    gpus: [],
    appleSilicon: false,
    ...o,
  };
}

describe('recommendCapacity', () => {
  it('sizes the limit from cores and RAM (the documented worked examples)', () => {
    // 4 cores / 8 GB -> cpu (4-2)/3 = 0, ram (8-4)/3 = 1 -> min 0 -> floor 1.
    expect(recommendCapacity(profile({ cpuCores: 4, totalRamMb: 8192 })).maxProjects).toBe(1);
    // 8 cores / 16 GB -> cpu 2, ram 4 -> 2.
    expect(recommendCapacity(profile({ cpuCores: 8, totalRamMb: 16384 })).maxProjects).toBe(2);
    // 10-core M-series / 32 GB -> cpu 2, ram (32-4)/4 = 7 -> 2 (CPU-bound).
    expect(
      recommendCapacity(profile({ cpuCores: 10, totalRamMb: 32768, appleSilicon: true })).maxProjects,
    ).toBe(2);
    // 16 cores / 64 GB -> cpu 4, ram 20 -> 4 (hard cap).
    const big = recommendCapacity(profile({ cpuCores: 16, totalRamMb: 65536 }));
    expect(big.maxProjects).toBe(4);
    expect(big.hardCapped).toBe(false); // uncapped value is exactly 4
    const huge = recommendCapacity(profile({ cpuCores: 32, totalRamMb: 131072 }));
    expect(huge.maxProjects).toBe(4);
    expect(huge.hardCapped).toBe(true);
  });

  it('never returns less than 1, even on a tiny machine', () => {
    expect(recommendCapacity(profile({ cpuCores: 1, totalRamMb: 2048 })).maxProjects).toBe(1);
  });

  it('charges Apple Silicon more RAM per run (unified memory is also GPU memory)', () => {
    const intel = recommendCapacity(profile({ cpuCores: 16, totalRamMb: 16384, appleSilicon: false }));
    const apple = recommendCapacity(profile({ cpuCores: 16, totalRamMb: 16384, appleSilicon: true }));
    expect(intel.ramSlots).toBeGreaterThan(apple.ramSlots);
  });

  it('derives budget points from the limit and always keeps exactly one heavy lane', () => {
    const c = recommendCapacity(profile({ cpuCores: 8, totalRamMb: 16384 }));
    expect(c.budgetPoints).toBe(c.maxProjects * 2);
    expect(c.heavyLanes).toBe(1);
    // The heavy-lane rule is explained regardless of machine size.
    expect(recommendCapacity(profile({ cpuCores: 64, totalRamMb: 262144 })).heavyLanes).toBe(1);
  });

  it('explains the limit, naming the binding resource', () => {
    const cpuBound = recommendCapacity(profile({ cpuCores: 4, totalRamMb: 65536 }));
    expect(cpuBound.reasons.join(' ')).toMatch(/CPU core count is the limiting factor/);
    const ramBound = recommendCapacity(profile({ cpuCores: 32, totalRamMb: 8192 }));
    expect(ramBound.reasons.join(' ')).toMatch(/memory is the limiting factor/);
  });

  it('ignores free RAM entirely (it fluctuates between reads)', () => {
    const a = recommendCapacity(profile({ freeRamMb: 100 }));
    const b = recommendCapacity(profile({ freeRamMb: 12000 }));
    expect(a.maxProjects).toBe(b.maxProjects);
  });
});

describe('effectiveCapacity', () => {
  const recommended = recommendCapacity(profile({ cpuCores: 8, totalRamMb: 16384 })); // 2

  it('follows the hardware recommendation in auto mode', () => {
    expect(effectiveCapacity(recommended, { mode: 'auto' }).maxProjects).toBe(2);
    expect(effectiveCapacity(recommended, undefined).maxProjects).toBe(2);
    // A stale manual number is ignored while in auto mode.
    expect(effectiveCapacity(recommended, { mode: 'auto', maxProjects: 7 }).maxProjects).toBe(2);
  });

  it('honours a manual pin, clamped to 1..8, and recomputes the budget', () => {
    expect(effectiveCapacity(recommended, { mode: 'manual', maxProjects: 4 }).maxProjects).toBe(4);
    expect(effectiveCapacity(recommended, { mode: 'manual', maxProjects: 4 }).budgetPoints).toBe(8);
    expect(effectiveCapacity(recommended, { mode: 'manual', maxProjects: 0 }).maxProjects).toBe(1);
    expect(effectiveCapacity(recommended, { mode: 'manual', maxProjects: 99 }).maxProjects).toBe(8);
  });

  it('keeps the single heavy lane even when the user raises the limit', () => {
    expect(effectiveCapacity(recommended, { mode: 'manual', maxProjects: 8 }).heavyLanes).toBe(1);
  });
});
