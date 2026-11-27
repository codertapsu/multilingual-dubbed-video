/**
 * Names whose character-by-character Hán-Việt reading means something else
 * to Vietnamese viewers: the established Vietnamese name is the one they
 * know. The planner wrote 东洋 as "Đông Dương" (French Indochina to a
 * Vietnamese viewer), 香江 as "Hương Giang" (the river of Huế) and 妈祖 as
 * "Mã Tổ" (claude-dubber, Phong Thủy Thiên Sư, 2026-11-27). Pure.
 */
export const VI_ESTABLISHED_NAMES: readonly { source: string; use: string; never: string; because?: string }[] = [
  { source: '东洋', use: 'Nhật Bản (or Đông Doanh)', never: 'Đông Dương', because: 'Indochina' },
  { source: '香江', use: 'Hồng Kông', never: 'Hương Giang', because: 'the river of Huế' },
  { source: '妈祖', use: 'Ma Tổ (or Thiên Hậu)', never: 'Mã Tổ or Mụ Tổ' },
];

/** The rule for a prompt that writes Vietnamese from Chinese: established names over literal readings. Pure. */
export function viEstablishedNamesRule(): string {
  const cases = VI_ESTABLISHED_NAMES.map((n) => `${n.source} → ${n.use}, never "${n.never}"${n.because ? ` (${n.because})` : ''}`);
  return (
    'A place, people or figure with an established Vietnamese name takes that name, not the character-by-character ' +
    `Hán-Việt reading, above all when the reading means something else to Vietnamese viewers: ${cases.join('; ')}.`
  );
}
