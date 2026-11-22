import { performance } from 'node:perf_hooks';
import { ProviderError } from './gemini.js';
import { analysisPrompt, replyPrompt } from './prompts.js';
import { batchSchema, hasFields, replySchema, validAnalysis, validReply } from './schema.js';

export const batchSize = 5;

function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseBatch(raw, expected) {
  const value = parseJson(raw);
  if (!hasFields(value, ['results']) || !Array.isArray(value.results)) return new Map();
  const expectedIds = new Set(expected.map(item => item.id));
  const results = new Map();
  for (const entry of value.results) {
    if (!expectedIds.has(entry?.id)) return new Map();
    if (results.has(entry.id)) {
      results.set(entry.id, null);
    } else {
      const valid = hasFields(entry, ['id', 'analysis']) && validAnalysis(entry.analysis);
      results.set(entry.id, valid ? entry.analysis : null);
    }
  }
  return results;
}

export async function analyzeReviews(reviews, { generate, cache }) {
  const start = performance.now();
  const metrics = { aiCalls: 0, cacheHits: 0, elapsedMs: 0 };
  const missing = [];
  const output = [];
  let providerError = null;

  for (const [index, review] of reviews.entries()) {
    const analysis = await cache.get(review.key);
    const row = { ...review, analysis, status: analysis ? 'analysed' : 'analysis_failed' };
    output.push(row);
    if (analysis) metrics.cacheHits++;
    else missing.push({ row, id: String(index + 1) });
  }

  for (let offset = 0; offset < missing.length; offset += batchSize) {
    let pending = missing.slice(offset, offset + batchSize);
    for (let attempt = 0; pending.length && attempt < 2; attempt++) {
      const data = pending.map(({ id, row }) => ({ id, review_text: row.text }));
      const repair = 'The previous output failed validation for these IDs. Return one valid entry per supplied ID.';
      try {
        const raw = await generate({
          prompt: attempt === 0 ? analysisPrompt : `${analysisPrompt}\n${repair}`,
          data,
          schema: batchSchema,
          onRequest() { metrics.aiCalls++; }
        });
        const results = parseBatch(raw, data);
        const invalid = [];
        for (const entry of pending) {
          const analysis = results.get(entry.id);
          if (!analysis) {
            invalid.push(entry);
            continue;
          }
          await cache.set(entry.row.key, analysis);
          entry.row.analysis = analysis;
          entry.row.status = 'analysed';
        }
        pending = invalid;
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        providerError = error.message;
        break;
      }
    }
    if (providerError) break;
  }

  metrics.elapsedMs = Math.round(performance.now() - start);
  return { reviews: output, metrics, providerError };
}

export async function suggestReply(review, generate) {
  const data = { review_text: review.text };
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await generate({ prompt: replyPrompt, data, schema: replySchema });
    const output = parseJson(raw);
    if (validReply(output)) return output.reply.trim();
  }
  throw new ProviderError('Gemini did not return a valid draft. Try generating it again.');
}
