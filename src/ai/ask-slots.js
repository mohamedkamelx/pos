/*
 * What a clarification question decides.
 *
 * A finite choice is a decision, not a sentence. For the click to be a
 * decision the system takes, one place has to know which field the question
 * decides, what pressing a button does about it, and which stable ids travel
 * with the card. That place is this file - not the prompt, not the renderer
 * and not the model.
 *
 * Three rules it exists to enforce:
 *
 *   - The model may name a slot in free words, but the vocabulary is closed
 *     here. `slot` stays a free string in the tool schema (tightening it
 *     would change an accepted set); the closed set lives in code.
 *   - Ids are minted by the system. The model never writes a clarification
 *     id, an option id or a record id.
 *   - An option's meaning travels as data (`none`, `action`, `record`), so
 *     the renderer can route a click instead of re-reading a label.
 */

'use strict';

/* One canonical slot vocabulary, with the operator's own wording on both
   sides of the language. Keys are the values used everywhere else. */
const SLOT_WORDS = {
  image: ['image', 'images', 'photo', 'picture', 'attachment', 'cover',
    'صورة', 'صور', 'الصورة', 'الصور', 'الصورة الفوتوغرافية'],
  category: ['category', 'categories', 'category name', 'category_name',
    'department', 'قسم', 'أقسام', 'اقسام',
    'فئة', 'الفئة', 'فئات', 'تصنيف', 'التصنيف', 'القسم'],
  target: ['product', 'item', 'record', 'target', 'منتج', 'منتجات', 'المنتج',
    'صنف', 'الأصناف', 'الاصناف', 'سجل'],
  price: ['price', 'selling price', 'selling_price', 'sale price', 'سعر',
    'السعر', 'سعر البيع', 'سعربيع'],
  cost: ['cost', 'cost price', 'cost_price', 'سعر التكلفة', 'التكلفة',
    'الكلفة', 'سعر التوريد'],
  quantity: ['quantity', 'stock', 'opening stock', 'opening_stock', 'count',
    'كمية', 'الكمية', 'كميه', 'المخزون', 'مخزون', 'الكميات'],
  name: ['name', 'product name', 'اسم', 'الاسم', 'اسم المنتج'],
  description: ['description', 'الوصف', 'وصف'],
  barcode: ['barcode', 'باركود', 'الباركود', 'الباركود'],
  sku: ['sku', 'كود', 'الكود', 'كود الصنف'],
};

/* What the page does with the question. `number` renders an inline numeric
   field instead of "type your answer below"; `attach` offers the picker;
   `record` means the choice names a shop record the system can look up. */
const SLOT_ACTIONS = {
  image: 'attach',
  target: 'record',
  category: 'record',
  price: 'number',
  cost: 'number',
  quantity: 'number',
  stock: 'number',
};

const SLOT_KEYS = Object.keys(SLOT_WORDS);

let minted = 0;

function cleanText(value, max) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > max ? text.slice(0, max) : text;
}

function normalise(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[_\s]+/g, ' ')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .trim();
}

/* A model-supplied slot or a field label, reduced to a canonical key.
   Returns '' when the wording names no slot: an unknown slot must take the
   legacy path rather than being guessed at. */
function normaliseSlot(value) {
  const wanted = normalise(value);
  if (!wanted) return '';
  for (const key of SLOT_KEYS) {
    if (wanted === key) return key;
  }
  for (const key of SLOT_KEYS) {
    for (const word of SLOT_WORDS[key]) {
      if (wanted === normalise(word)) return key;
    }
  }
  return '';
}

function slotFromFields(fields) {
  for (const field of Array.isArray(fields) ? fields : []) {
    const slot = normaliseSlot(field);
    if (slot) return slot;
  }
  return '';
}

/* When neither the slot nor a field label says it, the question's own words
   do - but several slots can appear in one sentence, and the earliest one is
   the one the question was built around. */
function slotFromQuestion(question) {
  const text = normalise(question);
  if (!text) return '';
  let best = '';
  let bestAt = -1;
  for (const key of SLOT_KEYS) {
    for (const word of SLOT_WORDS[key]) {
      const at = text.indexOf(normalise(word));
      if (at < 0) continue;
      if (bestAt < 0 || at < bestAt) {
        best = key;
        bestAt = at;
      }
    }
  }
  return best;
}

/* The slot of a stored or presented clarification: what it declared, then
   what it was asking for, then what its words say. */
function slotForClarification(item) {
  if (!item) return '';
  return normaliseSlot(item.slot) || slotFromFields(item.missing) || slotFromQuestion(item.question);
}

function slotAction(slot) {
  return SLOT_ACTIONS[normaliseSlot(slot)] || '';
}

/* Stable identity for a clarification and its options. The model never
   supplies these; the card sends them back and the resolver matches on them,
   so a click is never re-read from its wording. */
function mintClarificationId() {
  minted += 1;
  return `c${Date.now().toString(36)}${minted.toString(36)}`;
}

function recordFor(recordOf, label, slot) {
  if (typeof recordOf !== 'function') return null;
  let found = null;
  try {
    found = recordOf(label, slot);
  } catch (error) {
    return null;
  }
  if (!found || typeof found !== 'object') return null;
  const id = cleanText(found.id, 80);
  if (!id) return null;
  return { entity: cleanText(found.entity, 20) || 'product', id };
}

/* Give a clarification result its identity and its routing rules. Called
   exactly where a card is minted - the model's own ask, the local flow and
   the runtime's built-in choices - so every card leaving the system has the
   same shape and memory can reuse the id instead of inventing a second one. */
function presentClarification(result, { id = '', recordOf = null } = {}) {
  if (!result || result.kind !== 'clarify') return result;
  const slot = normaliseSlot(result.slot) ||
    slotFromFields(result.missing) ||
    slotFromQuestion(result.question);
  const action = slotAction(slot);
  const clarificationId = cleanText(id, 60) || mintClarificationId();
  const options = (Array.isArray(result.options) ? result.options : []).slice(0, 4)
    .map((option, index) => {
      const label = cleanText(option && option.label, 80);
      const none = !!(option && option.none);
      const given = option && option.record && option.record.id ? option.record : null;
      const record = none ? null : (given || recordFor(recordOf, label, slot));
      return {
        id: `o${index + 1}`,
        label,
        value: cleanText(option && (option.value || label), 160) || label,
        none,
        /* An image question with a non-declining option means "attach one":
           the other answer is the declining option, not a value. A record
           slot only becomes a record when a system id backs the label. */
        action: none ? '' : (action === 'attach' ? 'attach' : (record ? 'record' : '')),
        record,
      };
    })
    .filter((option) => option.label);
  return { ...result, slot, action, id: clarificationId, options };
}

module.exports = {
  SLOT_ACTIONS,
  SLOT_KEYS,
  SLOT_WORDS,
  mintClarificationId,
  normaliseSlot,
  presentClarification,
  slotAction,
  slotForClarification,
  slotFromFields,
  slotFromQuestion,
};
