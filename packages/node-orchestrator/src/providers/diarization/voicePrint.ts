/**
 * Voice prints: L2-normalised speaker embeddings from the speaker detection
 * engine's ERes2Net model, for the speakers it detects (POST /diarize,
 * /diarize-chunk, /link) and for any short recording, such as a cloned
 * voice's preview (POST /embed). They are compared by cosine similarity. In
 * that model the same person measured 0.58-0.84 and different people 0.1-0.3
 * (Phase 0, 2026-11-18); inside one drama's soundtrack, voices the diarizer
 * kept apart measured 0.58 (median) and one voice heard in two parts 0.89
 * (field report 2026-11-21, B2). Pitch is no substitute: a male clone at
 * 194 Hz sits above a female one at 174 Hz.
 */

/**
 * Cosine similarity of two prints, in -1..1. Prints of different lengths come
 * from different models and are not comparable: 0, as for an empty print. Pure.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  return normA > 0 && normB > 0 ? dot / Math.sqrt(normA * normB) : 0;
}
