import { createHash } from 'node:crypto';

const columns = ['review_id', 'product', 'rating', 'date', 'review_text'];

function parseRows(csv) {
  const rows = [];
  const source = csv.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  let fields = [];
  let value = '';
  let state = 'start';
  let malformed = false;
  let line = 1;
  let rowLine = 1;

  for (const char of source + '\n') {
    if (state === 'quoted') {
      if (char === '"') state = 'closed';
      else value += char;
    } else if (char === '"' && state === 'closed') {
      value += '"';
      state = 'quoted';
    } else if (char === ',' || char === '\n') {
      fields.push(value);
      if (char === '\n') {
        if (fields.length > 1 || fields[0].trim() || malformed) {
          rows.push({ fields, line: rowLine, malformed });
        }
        fields = [];
        malformed = false;
        rowLine = line + 1;
      }
      value = '';
      state = 'start';
    } else if (char === '"' && state === 'start') {
      state = 'quoted';
    } else {
      if (char === '"' || state === 'closed') malformed = true;
      value += char;
      state = 'plain';
    }
    if (char === '\n') line++;
  }

  if (state === 'quoted') rows.push({ fields, line: rowLine, malformed: true });
  return rows;
}

export function cleanCsv(csv) {
  const [header, ...rows] = parseRows(csv);
  const fields = header?.fields.map(value => value.trim().toLowerCase()) ?? [];
  if (header?.malformed || new Set(fields).size !== fields.length ||
      !columns.every(column => fields.includes(column))) {
    throw new Error('CSV must include review_id, product, rating, date and review_text headers.');
  }
  if (rows.length > 250) throw new Error('Upload a CSV with at most 250 review rows.');

  const index = Object.fromEntries(columns.map(column => [column, fields.indexOf(column)]));
  const seen = new Set();
  const reviews = [];
  const skipped = [];
  let unknownRatings = 0;

  for (const row of rows) {
    const values = row.fields;
    const id = values[index.review_id]?.trim() || `Row ${row.line}`;
    const product = values[index.product]?.trim();
    const reviewText = values[index.review_text]?.trim() ?? '';
    let reason;

    if (row.malformed || values.length !== fields.length) reason = 'Malformed row';
    else if (!reviewText) reason = 'Empty review';
    else if (reviewText.length > 4000 || id.length > 200 || product.length > 200) {
      reason = 'Review or metadata exceeds length limit';
    }

    if (reason) {
      skipped.push({ id, line: row.line, reason });
      continue;
    }

    const canonical = reviewText.normalize('NFC').replace(/\s+/gu, ' ');
    const key = createHash('sha256').update(canonical).digest('hex');
    if (seen.has(key)) {
      skipped.push({ id, line: row.line, reason: 'Duplicate review' });
      continue;
    }
    seen.add(key);

    const rawRating = values[index.rating].trim();
    const rating = /^[1-5]$/.test(rawRating) ? Number(rawRating) : null;
    if (rating === null) unknownRatings++;
    reviews.push({
      id, key, product: product || 'Unknown product', rating,
      date: values[index.date].trim().slice(0, 40), text: reviewText
    });
  }

  return { reviews, skipped, unknownRatings, totalRows: rows.length };
}
