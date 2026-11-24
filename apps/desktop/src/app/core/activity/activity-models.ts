/**
 * The activity list's and edit history's types, from the shared contract
 * (packages/shared models/activity.ts), for this feature's files: one seam,
 * like core/models is for the rest of the UI.
 */
export type {
  ActivityAgentSession,
  ActivityEntry,
  ActivityInitiator,
  ActivityState,
  ActivityStreamEvent,
  EditHistoryEntry,
  EditHistorySummary,
  UndoEditResult,
} from '@videodubber/shared';

/**
 * Why an undo was refused, per line (node-orchestrator activity/undo.ts
 * `UndoChange`): sent with the 409's error, for the History panel to word.
 */
export interface UndoChange {
  id?: string;
  atMs?: number;
  what:
    | 'sourceText'
    | 'translatedText'
    | 'timing'
    | 'speakerId'
    | 'voiceId'
    | 'speakingRate'
    | 'locked'
    | 'missing'
    | 'count'
    | 'translated'
    | 'structure'
    | 'already-undone';
  now?: string;
  expected?: string;
}
