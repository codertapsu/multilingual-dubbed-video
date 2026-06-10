import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** Union of all status-like strings we render as a pill. */
export type BadgeStatus =
  | 'created'
  | 'running'
  | 'paused'
  | 'failed'
  | 'completed'
  | 'pending'
  | 'skipped'
  | 'idle';

/** Maps a status to a global badge CSS class + readable label. */
const STATUS_META: Record<BadgeStatus, { cls: string; label: string }> = {
  created: { cls: 'badge-pending', label: 'Created' },
  idle: { cls: 'badge-pending', label: 'Idle' },
  pending: { cls: 'badge-pending', label: 'Pending' },
  running: { cls: 'badge-running', label: 'Running' },
  paused: { cls: 'badge-warning', label: 'Paused' },
  failed: { cls: 'badge-failed', label: 'Failed' },
  completed: { cls: 'badge-completed', label: 'Completed' },
  skipped: { cls: 'badge-skipped', label: 'Skipped' },
};

/** Small status pill used in lists and the pipeline view. */
@Component({
  selector: 'vd-status-badge',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="badge {{ meta().cls }}">{{ meta().label }}</span>`,
})
export class StatusBadgeComponent {
  readonly status = input.required<BadgeStatus>();

  protected readonly meta = computed(
    () => STATUS_META[this.status()] ?? STATUS_META.pending,
  );
}
