import Anthropic from '@anthropic-ai/sdk';
import type { ClaudeVerdict, EscalationReason, ReviewInput } from '../types.js';
import type { Store } from '../store/db.js';

const SCHEMA = {
  type: 'object',
  properties: {
    court: { type: 'string', enum: ['me', 'reviewer'] },
    blockingCount: { type: 'integer' },
    asks: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'string', enum: ['high', 'low'] },
  },
  required: ['court', 'blockingCount', 'asks', 'confidence'],
  additionalProperties: false,
} as const;

export function buildPrompt(review: ReviewInput, reason: EscalationReason): string {
  return [
    'You are reading one GitHub pull request review, written by a colleague',
    'reviewing code authored by the dashboard user.',
    '',
    `Ambiguity to resolve: ${reason}`,
    '',
    'Decide whether the ball is now in the AUTHOR\'s court ("me") — the review',
    'asks for changes — or the REVIEWER\'s court ("reviewer") — nothing is asked',
    'of the author. Then list, briefly, what is being asked for.',
    '',
    `Review state: ${review.state}`,
    `Review author: ${review.author}`,
    '--- review body ---',
    review.bodyText.slice(0, 20_000),
  ].join('\n');
}

export function parseVerdict(value: unknown): ClaudeVerdict {
  const v = value as Record<string, unknown>;
  if (v?.court !== 'me' && v?.court !== 'reviewer') {
    throw new Error(`Verdict "court" must be "me" or "reviewer", got ${String(v?.court)}`);
  }
  if (!Array.isArray(v.asks)) throw new Error('Verdict "asks" must be an array.');
  if (v.confidence !== 'high' && v.confidence !== 'low') {
    throw new Error('Verdict "confidence" must be "high" or "low".');
  }
  return {
    court: v.court,
    blockingCount: Number(v.blockingCount ?? 0),
    asks: v.asks.map(String),
    confidence: v.confidence,
  };
}

export type Ask = (prompt: string) => Promise<unknown>;

/** The real model call. Injected so tests never reach the network. */
export const askClaude: Ask = async (prompt) => {
  const client = new Anthropic();
  const response = await client.messages.create({
    model: 'claude-opus-5',
    max_tokens: 2048,
    thinking: { type: 'adaptive' },
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: prompt }],
  } as unknown as Parameters<typeof client.messages.create>[0]);

  const block = (response as { content: { type: string; text?: string }[] })
    .content.find((b) => b.type === 'text');
  if (!block?.text) throw new Error('Claude returned no text block.');
  return JSON.parse(block.text);
};

export async function resolveEscalation(
  review: ReviewInput,
  reason: EscalationReason,
  store: Store,
  ask: Ask = askClaude,
): Promise<ClaudeVerdict | null> {
  const cached = store.getVerdict(review.id, review.lastEditedAt);
  if (cached !== null) return cached;

  try {
    const verdict = parseVerdict(await ask(buildPrompt(review, reason)));
    store.putVerdict(review.id, review.lastEditedAt, verdict);
    return verdict;
  } catch {
    // Degrade: the caller keeps the deterministic bucket and says the
    // tie-break is unavailable.
    return null;
  }
}
