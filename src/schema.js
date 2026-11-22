export const sentiments = ['positive', 'neutral', 'negative'];
export const topics = ['quality', 'delivery', 'price', 'packaging', 'support', 'size_fit', 'other'];

const analysisFields = {
  sentiment: { type: 'string', enum: sentiments },
  topics: { type: 'array', items: { type: 'string', enum: topics }, minItems: 1, maxItems: topics.length },
  summary: { type: 'string' },
  needs_reply: { type: 'boolean' }
};

function objectSchema(properties) {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}

export const batchSchema = objectSchema({
  results: {
    type: 'array',
    items: objectSchema({ id: { type: 'string' }, analysis: objectSchema(analysisFields) })
  }
});

export const replySchema = objectSchema({ reply: { type: 'string' } });

export function hasFields(value, fields) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}

export function validLine(value, maxLength) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength &&
    !/[\r\n\u2028\u2029]/u.test(value);
}

export function validAnalysis(value) {
  return hasFields(value, Object.keys(analysisFields)) &&
    sentiments.includes(value.sentiment) &&
    Array.isArray(value.topics) && value.topics.length > 0 &&
    new Set(value.topics).size === value.topics.length &&
    value.topics.every(topic => topics.includes(topic)) &&
    validLine(value.summary, 320) && typeof value.needs_reply === 'boolean';
}

export function validReply(value) {
  return hasFields(value, ['reply']) && validLine(value.reply, 800);
}
