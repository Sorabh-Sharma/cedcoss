const $ = id => document.getElementById(id);
const topicNames = {
  quality: 'Quality', delivery: 'Delivery', price: 'Price', packaging: 'Packaging',
  support: 'Support', size_fit: 'Size & fit', other: 'Other'
};
const sentiments = ['positive', 'neutral', 'negative'];
const pageSize = 6;
const filters = ['product-filter', 'sentiment-filter', 'topic-filter'].map($);
let dataset = null;
let page = 1;
let draftTarget = null;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function percent(count, total) {
  return total ? `${(count * 100 / total).toFixed(1).replace(/\.0$/, '')}%` : '—';
}

function countText(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function expectedSentiment(rating) {
  if (rating <= 2) return 'negative';
  if (rating === 3) return 'neutral';
  return 'positive';
}

function mismatch(review) {
  return review.rating !== null && review.analysis && review.analysis.sentiment !== expectedSentiment(review.rating);
}

function renderThemes(id, rows) {
  const counts = new Map();
  for (const row of rows) {
    for (const topic of row.analysis.topics) counts.set(topic, (counts.get(topic) ?? 0) + 1);
  }
  const ranked = [...counts].sort(([a, countA], [b, countB]) =>
    countB - countA || topicNames[a].localeCompare(topicNames[b])).slice(0, 3);
  if (!ranked.length) {
    $(id).replaceChildren(element('p', 'No matching themes in this dataset.'));
    return;
  }
  const list = element('ol', undefined, 'theme-list');
  for (const [topic, count] of ranked) {
    const item = element('li');
    item.append(element('span', topicNames[topic]), element('strong', countText(count, 'review')));
    list.append(item);
  }
  $(id).replaceChildren(list);
}

function renderSummary() {
  const analysed = dataset.reviews.filter(row => row.analysis);
  const rated = analysed.filter(row => row.rating !== null);
  const agrees = rated.filter(row => !mismatch(row)).length;
  const failed = dataset.reviews.length - analysed.length;
  $('total').textContent = analysed.length;
  $('total-detail').textContent = `of ${dataset.totalRows} input rows`;

  for (const sentiment of sentiments) {
    const group = analysed.filter(row => row.analysis.sentiment === sentiment);
    $(sentiment).textContent = percent(group.length, analysed.length);
    $(`${sentiment}-detail`).textContent = countText(group.length, 'review');
    if (sentiment === 'positive') renderThemes('praises', group);
    if (sentiment === 'negative') renderThemes('complaints', group);
  }
  $('reply-count').textContent = analysed.filter(row => row.analysis.needs_reply).length;

  const { aiCalls, cacheHits, elapsedMs } = dataset.metrics;
  $('run-details').hidden = false;
  $('run-details').open = false;
  $('run-summary').textContent = [
    countText(dataset.skipped.length, 'row skipped', 'rows skipped'),
    countText(dataset.unknownRatings, 'unknown rating'),
    `${percent(agrees, rated.length)} rating agreement`
  ].join(' · ');
  $('cleaning-list').replaceChildren(
    element('li', `${countText(aiCalls, 'AI request')}, ${countText(cacheHits, 'cache hit')}, ${(elapsedMs / 1000).toFixed(2)} s`),
    element('li', `${countText(failed, 'analysis failure')} · ${agrees} of ${rated.length} rated reviews agree with sentiment`),
    ...dataset.skipped.map(row => element('li', `${row.id} (line ${row.line}) · ${row.reason}`))
  );
}

function addOptions(select, items) {
  select.length = 1;
  for (const [value, label] of items) select.add(new Option(label, value));
}

function renderDataset(name) {
  $('dataset-name').textContent = name;
  const products = [...new Set(dataset.reviews.map(row => row.product))].sort((a, b) => a.localeCompare(b));
  addOptions(filters[0], products.map(product => [product, product]));
  filters.forEach(filter => { filter.value = ''; });
  page = 1;
  renderSummary();
  renderTable();
}

function reviewRow(review) {
  const row = element('tr');
  const product = element('td', review.product, 'product');
  product.append(element('small', [review.id, review.date].filter(Boolean).join(' · '), 'subtext'));
  const rating = element('td', review.rating === null ? 'Unknown' : `${review.rating} / 5`);
  if (mismatch(review)) rating.append(element('small', 'Mismatch', 'subtext mismatch'));
  const sentiment = element('td');
  const kind = review.analysis?.sentiment;
  const label = kind ? kind[0].toUpperCase() + kind.slice(1) : 'Analysis failed';
  sentiment.append(element('span', label, `badge ${kind ?? 'failed'}`));
  const summary = element('td', undefined, 'summary');
  const view = element('button', review.analysis?.summary ?? 'View original review', 'text-button');
  view.title = 'View original review';
  view.addEventListener('click', () => openReview(review, false));
  summary.append(view);
  const topics = element('td');
  for (const topic of review.analysis?.topics ?? []) topics.append(element('span', topicNames[topic], 'chip'));
  const action = element('td', '—');
  if (review.analysis?.needs_reply) {
    const draft = element('button', 'Draft reply', 'text-button');
    draft.setAttribute('aria-label', `Draft reply for ${review.id}`);
    draft.addEventListener('click', () => openReview(review, true));
    action.replaceChildren(draft);
  }
  row.append(product, rating, sentiment, summary, topics, action);
  return row;
}

function renderTable() {
  if (!dataset) return;
  const [product, sentiment, topic] = filters.map(filter => filter.value);
  const matching = dataset.reviews.filter(review =>
    (!product || review.product === product) &&
    (!sentiment || (review.analysis?.sentiment ?? review.status) === sentiment) &&
    (!topic || review.analysis?.topics.includes(topic)));
  const pages = Math.max(1, Math.ceil(matching.length / pageSize));
  $('review-count').textContent = `Showing ${matching.length} of ${countText(dataset.reviews.length, 'review')}`;
  $('pagination').hidden = pages === 1;
  $('page-label').textContent = `Page ${page} of ${pages}`;
  $('previous').disabled = page === 1;
  $('next').disabled = page === pages;
  const rows = matching.slice((page - 1) * pageSize, page * pageSize).map(reviewRow);
  if (!rows.length) {
    const empty = element('td', 'No reviews match these filters.', 'empty-table');
    empty.colSpan = 6;
    const row = element('tr');
    row.append(empty);
    rows.push(row);
  }
  $('review-rows').replaceChildren(...rows);
}

function showStatus(message, error = false) {
  $('status').textContent = message;
  $('status').classList.toggle('error', error);
}

async function readJson(response) {
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? 'The request failed.');
  return payload;
}

async function upload(name, getContents) {
  $('file').disabled = true;
  $('choose-label').setAttribute('aria-disabled', 'true');
  $('use-sample').disabled = true;
  showStatus(`Analysing ${name}. Batch processing can take a moment.`);
  try {
    const contents = await getContents();
    const response = await fetch('/api/analyze', {
      method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: contents
    });
    dataset = await readJson(response);
    renderDataset(name);
    const successful = dataset.reviews.filter(review => review.analysis).length;
    if (dataset.providerError) showStatus(dataset.providerError, true);
    else if (dataset.reviews.length === 0) showStatus('No usable reviews were found. Check the skipped rows below.', true);
    else if (successful < dataset.reviews.length) {
      const failed = dataset.reviews.length - successful;
      showStatus(`Analysed ${countText(successful, 'review')}. ${countText(failed, 'review')} failed analysis. Upload again to retry.`, true);
    } else showStatus(`Analysis complete. ${countText(successful, 'review')} analysed.`);
  } catch (error) {
    showStatus(error.message, true);
  } finally {
    $('file').value = '';
    $('file').disabled = false;
    $('choose-label').removeAttribute('aria-disabled');
    $('use-sample').disabled = false;
  }
}

async function generateDraft(target) {
  $('draft-text').textContent = 'Generating a draft…';
  $('retry-draft').hidden = true;
  try {
    const response = await fetch('/api/reply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(target)
    });
    const data = await readJson(response);
    if (draftTarget === target) $('draft-text').textContent = data.reply;
  } catch (error) {
    if (draftTarget !== target) return;
    $('draft-text').textContent = error.message;
    $('retry-draft').hidden = false;
  }
}

function openReview(review, withDraft) {
  draftTarget = withDraft ? { session: dataset.session, key: review.key } : null;
  $('dialog-id').textContent = review.id;
  $('dialog-title').textContent = review.product;
  $('original-text').textContent = review.text;
  $('draft-panel').hidden = !withDraft;
  $('review-dialog').showModal();
  if (draftTarget) generateDraft(draftTarget);
}

addOptions(filters[2], Object.entries(topicNames));
for (const filter of filters) filter.addEventListener('change', () => { page = 1; renderTable(); });
$('previous').addEventListener('click', () => { page--; renderTable(); });
$('next').addEventListener('click', () => { page++; renderTable(); });
$('file').addEventListener('change', () => {
  const [file] = $('file').files;
  if (!file) return;
  if (file.size > 512 * 1024) {
    $('file').value = '';
    showStatus('Choose a CSV smaller than 512 KB.', true);
    return;
  }
  upload(file.name, () => file);
});
$('use-sample').addEventListener('click', () => upload('reviews.csv', async () => {
  const response = await fetch('/reviews.csv');
  if (!response.ok) throw new Error('Could not load the sample CSV.');
  return response.blob();
}));
$('review-dialog').addEventListener('close', () => { draftTarget = null; });
$('retry-draft').addEventListener('click', () => { if (draftTarget) generateDraft(draftTarget); });
