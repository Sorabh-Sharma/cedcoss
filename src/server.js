import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeReviews, suggestReply } from './analyze.js';
import { createCache } from './cache.js';
import { cleanCsv } from './csv.js';
import { createGemini, ProviderError } from './gemini.js';
import { analysisPrompt } from './prompts.js';
import { batchSchema } from './schema.js';

const maxUpload = 512 * 1024;
const files = new Map([
  ['/', ['../public/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['../public/app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['../public/style.css', 'text/css; charset=utf-8']],
  ['/reviews.csv', ['../reviews.csv', 'text/csv; charset=utf-8']]
]);

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

async function readBody(request, limit) {
  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      bytes += chunk.length;
      if (bytes > limit) {
        request.resume();
        throw new RequestError(413, 'Request exceeds the upload size limit.');
      }
      chunks.push(chunk);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch (error) {
    if (error instanceof TypeError) throw new RequestError(400, 'Upload a UTF-8 encoded CSV file.');
    throw error;
  }
}

function requireType(request, type) {
  if (request.headers['content-type']?.split(';')[0].trim() !== type) {
    throw new RequestError(415, `Expected a ${type} request.`);
  }
}

export function reviewLensServer({ generate, cache }) {
  const sessions = new Map();
  let uploadInProgress = false;

  return createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const pathname = request.url.split('?')[0];
    try {
      if (request.method === 'GET' && files.has(pathname)) {
        const [filename, type] = files.get(pathname);
        const content = await readFile(new URL(filename, import.meta.url));
        response.writeHead(200, { 'Content-Type': type });
        response.end(content);
        return;
      }

      if (request.method === 'POST' && pathname === '/api/analyze') {
        requireType(request, 'text/csv');
        if (uploadInProgress) throw new RequestError(409, 'Another upload is being analysed. Try again shortly.');
        uploadInProgress = true;
        try {
          const csv = await readBody(request, maxUpload);
          let cleaned;
          try {
            cleaned = cleanCsv(csv);
          } catch (error) {
            throw new RequestError(400, error.message);
          }
          const result = await analyzeReviews(cleaned.reviews, { generate, cache });
          const session = randomUUID();
          const eligible = result.reviews.filter(review => review.analysis?.needs_reply);
          sessions.set(session, {
            expires: Date.now() + 60 * 60 * 1000,
            reviews: new Map(eligible.map(review => [review.key, review])),
            drafts: new Map()
          });
          if (sessions.size > 12) sessions.delete(sessions.keys().next().value);
          const { skipped, unknownRatings, totalRows } = cleaned;
          sendJson(response, 200, { ...result, session, skipped, unknownRatings, totalRows });
        } finally {
          uploadInProgress = false;
        }
        return;
      }

      if (request.method === 'POST' && pathname === '/api/reply') {
        requireType(request, 'application/json');
        const raw = await readBody(request, 1024);
        let input;
        try {
          input = JSON.parse(raw);
        } catch {
          throw new RequestError(400, 'Invalid reply request.');
        }

        const session = sessions.get(input?.session);
        if (!session || session.expires < Date.now()) {
          sessions.delete(input?.session);
          throw new RequestError(404, 'This analysis session has expired. Upload the file again to restore it from cache.');
        }
        const review = session.reviews.get(input?.key);
        if (!review) throw new RequestError(404, 'No reply is needed for this review.');
        if (!session.drafts.has(review.key)) {
          const draft = suggestReply(review, generate).catch(error => {
            session.drafts.delete(review.key);
            throw error;
          });
          session.drafts.set(review.key, draft);
        }
        sendJson(response, 200, { reply: await session.drafts.get(review.key) });
        return;
      }

      throw new RequestError(404, 'Page not found.');
    } catch (error) {
      if (error instanceof RequestError) sendJson(response, error.status, { error: error.message });
      else if (error instanceof ProviderError) sendJson(response, 502, { error: error.message });
      else {
        console.error('ReviewLens request failed', error);
        sendJson(response, 500, { error: 'The server could not complete this request.' });
      }
    }
  });
}

if (import.meta.main ?? (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  const model = process.env.GEMINI_MODEL?.trim() || 'gemini-3.1-flash-lite';
  const port = Number(process.env.PORT || 3000);
  const generate = createGemini({ apiKey, model });
  const cache = createCache(resolve('.reviewlens/cache'), JSON.stringify([model, analysisPrompt, batchSchema]));
  const server = reviewLensServer({ generate, cache });
  server.listen(port, '127.0.0.1', () => console.log(`ReviewLens is running at http://127.0.0.1:${server.address().port}`));
}
