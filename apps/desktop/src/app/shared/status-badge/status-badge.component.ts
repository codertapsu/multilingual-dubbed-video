import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { TranslatePipe } from '../../core/i18n';

/** Union of all status-like strings we render as a pill. */
export type BadgeStatus =
  | 'created'
  | 'queued'
  | 'running'
  | 'paused'
  | 'failed'
  | 'completed'
  | 'pending'
  | 'skipped'
  | 'idle';

/**
 * Maps a status to a global badge CSS class + its TRANSLATION KEY.
 *
 * `label` must be a key, never prose: the template pipes it through
 * `| translate`, and `TranslateService.instant` returns the key verbatim on a
 * total miss. This table shipped English literals ('Created', 'Running', …),
 * which resolve to no key in either locale — so every status pill on Home, on
 * Processing's overall badge and on all nine pipeline step rows rendered raw
 * English to the default (Vietnamese) audience, even though `status.created`,
 * `status.running`, … were already translated in both locales. check-i18n
 * cannot see literals like 'Created' (they fail its dotted-key pattern), so
 * nothing caught it.
 */
const STATUS_META: Record<BadgeStatus, { cls: string; label: string }> = {
  created: { cls: 'badge-pending', label: 'status.created' },
  idle: { cls: 'badge-pending', label: 'status.idle' },
  pending: { cls: 'badge-pending', label: 'status.pending' },
  queued: { cls: 'badge-warning', label: 'status.queued' },
  running: { cls: 'badge-running', label: 'status.running' },
  paused: { cls: 'badge-warning', label: 'status.paused' },
  failed: { cls: 'badge-failed', label: 'status.failed' },
  completed: { cls: 'badge-completed', label: 'status.completed' },
  skipped: { cls: 'badge-skipped', label: 'status.skipped' },
};

/** Small status pill used in lists and the pipeline view. */
@Component({
  selector: 'vd-status-badge',
  standalone: true,
  imports: [TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="badge {{ meta().cls }}">{{ meta().label | translate }}</span>`,
})
export class StatusBadgeComponent {
  readonly status = input.required<BadgeStatus>();

  protected readonly meta = computed(
    () => STATUS_META[this.status()] ?? STATUS_META.pending,
  );
}
