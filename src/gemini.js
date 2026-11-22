import { setTimeout as sleep } from 'node:timers/promises';

export class ProviderError extends Error {}

function retryDelay(header) {
  if (!header) return 0;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(header) - Date.now()) || 0;
}

export function createGemini({
  apiKey, model, fetchRequest = fetch, wait = sleep, endpoint = 'https://generativelanguage.googleapis.com/v1beta'
}) {
  const url = `${endpoint}/models/${encodeURIComponent(model)}:generateContent`;

  return async function generate({ prompt, data, schema, onRequest = () => {} }) {
    if (!apiKey) throw new ProviderError('Set GEMINI_API_KEY in .env and restart the app.');
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: prompt }] },
      contents: [{ role: 'user', parts: [{ text: JSON.stringify(data) }] }],
      generationConfig: {
        responseMimeType: 'application/json', responseJsonSchema: schema, maxOutputTokens: 2048
      }
    });

    for (let attempt = 0; attempt < 3; attempt++) {
      let delay = 1000 * 2 ** attempt;
      onRequest();
      try {
        const response = await fetchRequest(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body,
          signal: AbortSignal.timeout(20_000)
        });
        if (response.ok) {
          // A successful HTTP response can still contain missing or malformed model text.
          const result = await response.json().catch(() => null);
          const candidate = result?.candidates?.[0];
          if (candidate?.finishReason !== 'STOP') return '';
          return candidate.content?.parts?.filter(part => !part.thought).map(part => part.text ?? '').join('') ?? '';
        }
        await response.body?.cancel();
        if (response.status !== 429 && response.status < 500) {
          throw new ProviderError(`Gemini rejected the request (HTTP ${response.status}). Check your key and model configuration.`);
        }
        delay = Math.max(delay, retryDelay(response.headers.get('retry-after')));
      } catch (error) {
        if (error instanceof ProviderError) throw error;
      }
      if (attempt === 2 || delay > 30_000) break;
      await wait(delay);
    }
    throw new ProviderError('Gemini is temporarily unavailable or rate-limited. Try uploading again later.');
  };
}
