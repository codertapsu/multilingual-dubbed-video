/**
 * How a voice can be heard before a dub: its catalog sample, or (installed)
 * the voice itself saying a sentence. Shared by the Voices screen and the New
 * project form, so both play a voice the same way.
 */
import type { VoiceLibraryItem } from '../../core/models';
import { baseLanguage } from './voice-filter';

/** What an installed voice without a sample says, in its own language. */
export const SAMPLE_SENTENCES: Readonly<Record<string, string>> = {
  vi: 'Xin chào, đây là giọng đọc dùng để lồng tiếng cho video của bạn.',
  en: 'Hello, this is a voice you can use to dub your videos.',
  ja: 'こんにちは、これはあなたの動画の吹き替えに使える声です。',
  zh: '你好，这是可以为你的视频配音的声音。',
  es: 'Hola, esta es una voz que puedes usar para doblar tus vídeos.',
  fr: 'Bonjour, voici une voix que vous pouvez utiliser pour doubler vos vidéos.',
  hi: 'नमस्ते, यह एक आवाज़ है जिससे आप अपने वीडियो डब कर सकते हैं।',
  it: 'Ciao, questa è una voce che puoi usare per doppiare i tuoi video.',
  pt: 'Olá, esta é uma voz que você pode usar para dublar seus vídeos.',
  ko: '안녕하세요, 동영상 더빙에 사용할 수 있는 목소리입니다.',
  de: 'Hallo, das ist eine Stimme, mit der du deine Videos synchronisieren kannst.',
  ru: 'Здравствуйте, этим голосом можно озвучивать ваши видео.',
};

/** The sample sentence for a language (English when there is none for it). */
export function sampleSentence(language: string): string {
  return SAMPLE_SENTENCES[baseLanguage(language)] ?? SAMPLE_SENTENCES['en']!;
}

/**
 * Where a voice's preview comes from: 'speak' (an installed voice says a
 * sentence: the user's own, or a default when the catalog has no sample),
 * 'sample' (the catalog's recording, playable before installing), or null when
 * there is nothing to play. OpenAI voices never speak here: that would be a
 * billed request to a cloud service just to listen.
 */
export function previewSource(
  item: Pick<VoiceLibraryItem, 'engine' | 'installed' | 'sample' | 'hasPreview'> | undefined,
  ownSentence = '',
): 'speak' | 'sample' | null {
  if (!item) return null;
  if (item.installed && item.engine !== 'openai' && (ownSentence.trim() !== '' || !item.sample)) return 'speak';
  return item.hasPreview ? 'sample' : null;
}
