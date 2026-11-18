/**
 * The statement a user agrees to before a voice is cloned (docs/VOICE_CLONING.md).
 *
 * It is stored literally with the voice, in the language it was shown in, with
 * its version and the moment it was accepted, so the record shows what the user
 * actually read. A new version asks again. The declaration is the user's
 * commitment, not identity verification, and the app says so where it asks.
 */
import { AppErrorException, type VoiceConsent } from '@videodubber/shared';

export const CONSENT_VERSION = '2026-11-18';

export type ConsentRelation = VoiceConsent['relation'];
export type ConsentLocale = 'vi' | 'en';

const STATEMENTS: Record<ConsentLocale, Record<ConsentRelation, string>> = {
  vi: {
    self: 'Tôi xác nhận đây là giọng của chính tôi. Tôi sẽ không dùng giọng này để mạo danh, lừa đảo hay gây hiểu lầm, và sẽ ghi rõ giọng đọc do AI tạo khi đăng công khai.',
    authorized:
      'Tôi xác nhận chủ của giọng nói này đã đồng ý cho tôi nhân bản giọng bằng AI để lồng tiếng. Tôi sẽ không dùng giọng này để mạo danh, lừa đảo hay gây hiểu lầm, và sẽ ghi rõ giọng đọc do AI tạo khi đăng công khai.',
    'source-video':
      'Tôi có quyền sử dụng giọng nói trong video này cho bản lồng tiếng của nó. Tôi sẽ không dùng giọng này để mạo danh, lừa đảo hay gây hiểu lầm, và sẽ ghi rõ giọng đọc do AI tạo khi đăng công khai.',
  },
  en: {
    self: 'I confirm this is my own voice. I will not use it to impersonate, defraud or mislead anyone, and I will say that the voice is AI-generated when I publish.',
    authorized:
      'I confirm the owner of this voice has agreed to have it cloned with AI for dubbing. I will not use it to impersonate, defraud or mislead anyone, and I will say that the voice is AI-generated when I publish.',
    'source-video':
      'I have the right to use the voices in this video for its dub. I will not use them to impersonate, defraud or mislead anyone, and I will say that the voices are AI-generated when I publish.',
  },
};

export function consentStatements(locale: ConsentLocale): { version: string; statements: Record<ConsentRelation, string> } {
  return { version: CONSENT_VERSION, statements: { ...STATEMENTS[locale] } };
}

/** What the client sends when the user ticks the declaration. */
export interface ConsentInput {
  relation?: string;
  statementVersion?: string;
  locale?: string;
  accepted?: boolean;
}

/**
 * The consent record to store, or VOICE_CONSENT_REQUIRED. A project's
 * source-video statement is valid only for a voice that stays in that project.
 */
export function acceptConsent(input: ConsentInput | undefined, scope: 'library' | 'project', now = new Date()): VoiceConsent {
  const relation = input?.relation as ConsentRelation | undefined;
  if (!input?.accepted || !relation || !(relation in STATEMENTS.vi)) {
    throw new AppErrorException('VOICE_CONSENT_REQUIRED', 'Cloning a voice needs your confirmation that you may use it.');
  }
  if (input.statementVersion !== CONSENT_VERSION) {
    throw new AppErrorException(
      'VOICE_CONSENT_REQUIRED',
      'The statement you agreed to has changed. Read it again and confirm.',
    );
  }
  if (relation === 'source-video' && scope !== 'project') {
    throw new AppErrorException(
      'VOICE_CONSENT_REQUIRED',
      "A voice made from a video's speakers stays in that video's project.",
    );
  }
  const locale: ConsentLocale = input.locale === 'en' ? 'en' : 'vi';
  return {
    statementVersion: CONSENT_VERSION,
    statementText: STATEMENTS[locale][relation],
    acceptedAt: now.toISOString(),
    relation,
    method: 'declaration',
  };
}
