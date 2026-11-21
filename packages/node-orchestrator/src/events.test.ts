import { describe, expect, it } from 'vitest';

import type { PipelineState } from '@videodubber/shared';

import { ProjectEventBus, type PipelineEvent } from './events.js';

function state(status: PipelineState['status']): PipelineEvent {
  return { type: 'state', pipeline: { projectId: 'p1', status, steps: [] } as unknown as PipelineState };
}

/** What a page that connects now is replayed. */
function replayed(bus: ProjectEventBus): string[] {
  const seen: string[] = [];
  const off = bus.subscribe((e) => seen.push(e.type === 'state' ? `state:${e.pipeline.status}` : e.type));
  off();
  return seen;
}

describe('ProjectEventBus replay', () => {
  it('replays the last state and how the run ended', () => {
    const bus = new ProjectEventBus('p1');
    bus.emit(state('running'));
    bus.emit(state('completed'));
    bus.emit({ type: 'done' } as PipelineEvent);
    expect(replayed(bus)).toEqual(['state:completed', 'done']);
  });

  it('forgets the last run’s ending once a new run starts', () => {
    const bus = new ProjectEventBus('p1');
    bus.emit(state('failed'));
    bus.emit({ type: 'error', error: { code: 'UNKNOWN', message: 'old failure' } } as PipelineEvent);
    bus.emit(state('running'));
    expect(replayed(bus)).toEqual(['state:running']);
  });

  /** fail -> retry -> pause: the page must not show the first run's failure. */
  it('does not bring an old failure back with a later pause', () => {
    const bus = new ProjectEventBus('p1');
    bus.emit({ type: 'error', error: { code: 'UNKNOWN', message: 'old failure' } } as PipelineEvent);
    bus.emit(state('running'));
    bus.emit(state('paused'));
    expect(replayed(bus)).toEqual(['state:paused']);
  });
});
