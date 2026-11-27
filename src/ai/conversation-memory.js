/*
 * Bounded conversation memory for the Posnic assistant.
 *
 * The OpenCode session is the model's working context. It is intentionally
 * short-lived: a topic change, a long topic or a provider context error starts
 * a fresh session. This store is the durable part that survives those resets.
 *
 * It keeps:
 *   - one active topic and an index of earlier topics;
 *   - the exact points the user made, without duplicates;
 *   - corrections and already-answered clarifications;
 *   - product/category records and plan previews returned by tools;
 *   - a short extractive summary per topic.
 *
 * Everything is in memory and scoped to one conversation id. No token, JWT or
 * shop credential is stored here. The context block and the recall tool read
 * only this conversation.
 */

'use strict';

const { isHowToQuestion } = require('./text-match');
const { normaliseSlot, slotForClarification, NUMERIC_SLOTS } = require('./ask-slots');
const { foldName } = require('./text-fold');
/* One copy of the number rule, shared with the card that collects it. */
const { parseNumberInput } = require('../../frontend/static/script/js/core/numeric-input');

const MAX_CONVERSATIONS = 40;
const MAX_TOPICS = 40;
const MAX_POINTS = 12;
const MAX_CORRECTIONS = 8;
const MAX_TURNS = 8;
const MAX_PRODUCTS = 40;
const MAX_CATEGORIES = 24;
const MAX_PLANS = 8;
const MAX_CLARIFICATIONS = 8;
const MAX_KEYWORDS = 32;
/* Ids a tool showed this conversation, remembered for one reason only: a plan
   may target a record by id only when that id was actually seen here. */
const MAX_SEEN_IDS = 200;
const MAX_CONTEXT_CHARS = 6000;
const MAX_SHORT_CONTEXT_CHARS = 2200;
const MAX_SUMMARY_CHARS = 700;
const MAX_POINT_CHARS = 240;
const MAX_TEXT_CHARS = 500;
const MAX_TITLE_CHARS = 80;
const CONVERSATION_TTL_MS = 2 * 60 * 60 * 1000;

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'could',
  'did', 'do', 'does', 'for', 'from', 'had', 'has', 'have', 'he', 'her',
  'here', 'him', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its',
  'just', 'me', 'my', 'no', 'not', 'of', 'on', 'or', 'our', 'please', 'so',
  'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this',
  'those', 'to', 'too', 'up', 'us', 'was', 'we', 'were', 'what', 'when',
  'where', 'which', 'who', 'why', 'will', 'with', 'would', 'you', 'your',
  'أنا', 'أنت', 'أنتي', 'انت', 'انتي', 'هو', 'هي', 'هم', 'نحن', 'في', 'من',
  'على', 'إلى', 'الى', 'عن', 'مع', 'هذا', 'هذه', 'ذلك', 'تلك', 'التي',
  'الذي', 'الذين', 'هنا', 'هناك', 'هل', 'ما', 'ماذا', 'لماذا', 'كيف',
  'متى', 'أين', 'اين', 'و', 'أو', 'او', 'ثم', 'بل', 'لا', 'نعم', 'كل',
  'بعض', 'أي', 'اي', 'أيضا', 'أيضاً', 'ايضا', 'كذلك', 'لي', 'لك', 'لنا',
  'من فضلك', 'لو', 'إن', 'ان', 'قد', 'كان', 'كانت', 'يكون', 'تكون',
]);

const TOKEN_RE = /[a-z0-9\u0600-\u06FF]+/g;
const ARABIC_DIACRITICS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/g;

const NEW_TOPIC_PHRASES = [
  'new topic', 'different topic', 'change the subject', 'change subject',
  'another question', 'separate question', 'unrelated question', 'moving on',
  'by the way', 'on another note', 'different question',
  'موضوع جديد', 'موضوع آخر', 'موضوع ثاني', 'سؤال جديد', 'سؤال آخر',
  'سؤال ثاني', 'نغير الموضوع', 'تغيير الموضوع', 'موضوع مختلف', 'بالمناسبة',
  'على فكرة', 'شي ثاني', 'شيء آخر', 'سؤال مختلف', 'سيبك من ده', 'سيبك من دا',
  'سيبك من الموضوع', 'بلاش ده', 'مش ده', 'حاجة تانية', 'حاجه تانيه',
  'كلام تاني', 'كلام ثاني',
];

const BACK_PHRASES = [
  'back to', 'go back', 'earlier', 'previous', 'before', 'we discussed',
  'we talked about', 'you mentioned', 'the one', 'that product',
  'same product', 'the product from', 'the category from', 'remember',
  'نرجع', 'ارجع', 'العودة', 'المنتج السابق', 'المنتج اللي', 'اللي تحدثنا',
  'اللي تكلمنا', 'اللي قلنا', 'السابق', 'السابقة', 'قبل شوي', 'قبل قليل',
  'نفس المنتج', 'نفس الصنف', 'المنتج نفسه', 'تذكر', 'تتذكر', 'قلنا',
  'تكلمنا', 'تحدثنا', 'الموضوع السابق', 'السؤال السابق',
];

const CONTINUATION_PHRASES = [
  'it', 'this', 'that', 'these', 'those', 'same', 'also', 'and', 'what about',
  'how about', 'then', 'next', 'there', 'its', 'they', 'them', 'one more',
  'again', 'do it', 'go ahead',
  'هذا', 'هذه', 'ذلك', 'تلك', 'نفس', 'نفسه', 'نفسها', 'أيضا', 'أيضاً',
  'كذلك', 'كمان', 'ثم', 'بعدين', 'وش عنه', 'ماذا عن', 'ماذا بشأن',
  'المنتج', 'الصنف', 'الخطة', 'التعديل', 'نفس الشي', 'نفس الشيء',
];

const ACTION_PHRASES = [
  'edit', 'change', 'update', 'set', 'add', 'remove', 'delete', 'make',
  'rename', 'adjust', 'fix', 'create', 'price', 'stock', 'description',
  'barcode', 'sku', 'category', 'name', 'quantity',
  'عدل', 'غير', 'حدث', 'أضف', 'اضف', 'احذف', 'امسح', 'اجعل', 'سعر',
  'مخزون', 'كمية', 'وصف', 'باركود', 'صنف', 'فئة', 'اسم', 'عدّل',
  'غيّر', 'حدّث',
];

const NEW_ENTITY_PHRASES = [
  'add a product', 'create a product', 'new product', 'add product',
  'add a category', 'create a category', 'new category', 'add category',
  'أضف منتج', 'أضف صنف', 'منتج جديد', 'صنف جديد', 'أضف فئة', 'فئة جديدة',
  'أنشئ منتج', 'أنشئ صنف', 'اضف منتج', 'اضف صنف', 'ضيف منتج', 'ضيف صنف',
  'ضيف برودكت', 'اضف برودكت', 'برودكت جديد', 'حزمة جديدة',
];

const CORRECTION_PHRASES = [
  'actually', 'instead', 'rather', 'no,', 'not that', 'i meant', 'correction',
  'بالعكس', 'في الحقيقة', 'لا،', 'لا,', 'بل', 'أقصد', 'اقصد', 'بدلا',
  'بدلاً', 'غير ذلك', 'مش كده', 'مش كذا', 'مش صح', 'مش قصدي', 'مش هذا',
];

const WRITE_ACTION_PHRASES = [
  'add', 'create', 'update', 'change', 'set', 'rename', 'adjust', 'delete',
  'remove', 'make', 'edit', 'save',
  'أضف', 'اضف', 'ضيف', 'ضيفي', 'أنشئ', 'انشئ', 'انشئي', 'عدل', 'عدّل',
  'عدلي', 'غير', 'غيّر', 'غيري', 'حدث', 'حدّث', 'حدثي', 'احذف', 'امسح',
  'اجعل', 'خلي', 'خلى', 'خليها', 'سجل', 'اعمل', 'سوي',
];

const CANCEL_PHRASES = [
  'cancel', 'never mind', 'nevermind', 'forget it', 'stop', 'abort',
  'الغي', 'ألغي', 'إلغاء', 'الغاء', 'بلاش', 'انسى', 'انسي', 'لا تكممل',
  'لا تكمل', 'وقف', 'مش عايز', 'مش عاوز', 'سيبك', 'سيب', 'كفاية',
];

const ABANDON_PHRASES = [
  'سيبك من ده', 'سيبك من دا', 'سيبك من الموضوع', 'بلاش ده', 'مش ده',
  'forget this', 'drop this', 'leave this',
];

/* A read question in the middle of a write task is a side question, not an
   answer to the pending question. It pauses the task instead of replacing it
   or spending a correction turn. */
const QUESTION_INTENT_RE = /(?:^|\s)(?:فين|وين|كام|إيه|ايه|إيش|ايش|هل|مين|ليه|لماذا|ازاي|إزاي|كيف|متى|امتى|أين|اين|وريني|ورينى|اعرض|أعرض|اظهر|أظهر|قولي|أعرف|اعرف|what|where|how|when|who|why|which|show|list|find|search|tell\s+me)(?:\s|$)/i;
const QUESTION_MARK_RE = /[?؟]\s*$/;
const VALUE_ONLY_RE = /^\s*[\d٠-٩]+(?:[.,][\d٠-٩]+)?\s*[?؟]?\s*$/;
const ACK_ONLY_RE = /^(?:تمام|تم|ماشي|حاضر|اوك|أوك|اوكي|أوكي|ok|okay|sure|yes|نعم|موافق)[!.?]*$/i;
const CREATE_ENTITY_RE = /(?:أضيف|اضيف|أضف|اضف|ضيف|أنشئ|انشئ|سجل|اعمل|create|add|new)\s+(?:منتج|صنف|برودكت|product|item)|(?:منتج|صنف|برودكت|product|item)\s+(?:جديد|جديده|جديدة|new)/i;
const CORRECTION_ACTION_RE = /(?:^|\s)(?:غير|غيّر|عدل|عدّل|صحح|بدل|خلي|خلى|اجعل|اجعلها|update|change|set|fix|correct)\b|(?:أضف|اضف|زود|قلل)\s+[\d٠-٩]+\s*(?:لل|لـ|ل)|(?:سعر|تكلفة|كمية|مخزون|price|cost|stock|quantity)\s*[:=]?\s*[\d٠-٩]+/i;

const NOT_IMPORTANT_RE = /^(مش مهم|مش مهمه|مش مهمة|لا يهم|مهمش|مش ضروري|مش ضرورى|whatever|doesn'?t matter|not important|skip)[!.?]*$/i;

/* One explicit stage per topic keeps the model from confusing an unfinished
   request with a pending preview or a completed change. The stage is written
   by the same store that records the pending request and the plans, so it
   survives a provider session reset. */
const STAGE_GUIDANCE = {
  collecting: 'Stage: collecting the values for an unfinished request. Ask for the missing values themselves; never ask for permission to continue or whether to enter them.',
  paused: 'Stage: the user asked a side question while a request is unfinished. Answer the side question, then remind the user that the unfinished request is still waiting; do not discard it.',
  awaiting_confirmation: 'Stage: a plan preview is waiting for the user to press Confirm. Do not ask for confirmation in chat, do not propose another plan, and do not claim the change is done. If the user asks a side question, answer it and remind them the preview is still waiting.',
  done: 'Stage: the last plan completed. The records exist; do not create them again. Answer questions about them.',
  cancelled: 'Stage: the last request was cancelled. Do not continue it unless the user asks again.',
  failed: 'Stage: the last plan failed. Report the failure and ask only for the values needed to retry.',
};

const GREETING_RE = /^(hi|hello|hey|thanks|thank you|good morning|good evening|السلام عليكم|مرحبا|أهلا|اهلا|شكرا|شكراً|صباح الخير|مساء الخير)[!.?]*$/i;
const SHORT_REPLY_RE = /^(yes|no|ok|okay|sure|continue|go ahead|do it|نعم|لا|أوكي|اوكي|تمام|موافق|كمل|تابع|تفضل|استمر)[!.?]*$/i;

function cleanText(value, max) {
  let text = typeof value === 'string' ? value : '';
  text = text.replace(ARABIC_DIACRITICS, '');
  text = text.replace(/\s+/g, ' ').trim();
  text = text
    .replace(/\[\s*conversation memory\s*\]/gi, '(memory)')
    .replace(/\[\s*end conversation memory\s*\]/gi, '(end memory)');
  const limit = Number.isFinite(max) ? max : MAX_TEXT_CHARS;
  return text.length > limit ? text.slice(0, limit).trim() : text;
}

function normalise(value) {
  return cleanText(value, 4000).toLowerCase();
}

function stemToken(token) {
  let word = token;
  if (word.length > 4 && word.startsWith('ال')) word = word.slice(2);
  if (word.length > 4 && (word.endsWith('ات') || word.endsWith('ين') || word.endsWith('ون'))) {
    word = word.slice(0, -2);
  }
  if (word.length > 4 && (word.endsWith('ها') || word.endsWith('هم') || word.endsWith('نا'))) {
    word = word.slice(0, -2);
  }
  return word;
}

function rawTokens(value) {
  return normalise(value).match(TOKEN_RE) || [];
}

function tokenForms(value) {
  const forms = new Set();
  for (const token of rawTokens(value)) {
    if (token.length < 2 || STOPWORDS.has(token)) continue;
    forms.add(token);
    const stem = stemToken(token);
    if (stem.length >= 2 && stem !== token) forms.add(stem);
  }
  return forms;
}

function keywordList(value) {
  const seen = new Set();
  const list = [];
  for (const token of rawTokens(value)) {
    if (token.length < 2 || STOPWORDS.has(token)) continue;
    const stem = stemToken(token);
    const key = stem.length >= 2 ? stem : token;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(token);
    if (list.length >= MAX_KEYWORDS) break;
  }
  return list;
}

function hasPhrase(value, phrases) {
  const text = normalise(value);
  if (!text) return false;
  const padded = ` ${text} `;
  return phrases.some((phrase) => padded.includes(` ${phrase} `) || text.includes(phrase));
}

/* A write request that is still waiting for an answer. It is kept on the
   topic, not in the model session, because the session can be reset by a
   provider error or a compaction. */
function looksLikeWriteRequest(value) {
  if (isHowToQuestion(value)) return false;
  return hasPhrase(value, WRITE_ACTION_PHRASES) || hasPhrase(value, NEW_ENTITY_PHRASES);
}

function isCancellation(value) {
  return hasPhrase(value, CANCEL_PHRASES);
}

function isAbandon(value) {
  return hasPhrase(value, ABANDON_PHRASES);
}

function isNotImportant(value) {
  return NOT_IMPORTANT_RE.test(normalise(value));
}

function looksLikeQuestion(value) {
  const text = normalise(value);
  if (!text || VALUE_ONLY_RE.test(text)) return false;
  if (QUESTION_MARK_RE.test(text)) return true;
  return QUESTION_INTENT_RE.test(` ${text} `);
}

function looksLikeCorrection(value) {
  const text = normalise(value);
  if (!text) return false;
  return hasPhrase(value, CORRECTION_PHRASES) || CORRECTION_ACTION_RE.test(text);
}

function nowStamp() {
  return Date.now();
}

function createConversationMemoryStore({
  now = Date.now,
  maxConversations = MAX_CONVERSATIONS,
  maxTopics = MAX_TOPICS,
} = {}) {
  const conversations = new Map();
  const current = typeof now === 'function' ? now : nowStamp;

  function key(conversationId) {
    return String(conversationId || '').trim().slice(0, 100);
  }

  function pruneExpired() {
    const cutoff = current() - CONVERSATION_TTL_MS;
    for (const [id, conversation] of conversations.entries()) {
      if (conversation.updatedAt < cutoff) conversations.delete(id);
    }
  }

  function evictIfNeeded() {
    if (conversations.size <= maxConversations) return;
    const oldest = [...conversations.entries()]
      .sort((left, right) => left[1].updatedAt - right[1].updatedAt)[0];
    if (oldest) conversations.delete(oldest[0]);
  }

  function ensureConversation(conversationId) {
    const id = key(conversationId);
    if (!id) return null;
    pruneExpired();
    let conversation = conversations.get(id);
    if (!conversation) {
      conversation = {
        id,
        createdAt: current(),
        updatedAt: current(),
        activeTopicId: '',
        topics: [],
        nextTopic: 1,
      };
      conversations.set(id, conversation);
      evictIfNeeded();
    }
    return conversation;
  }

  function activeTopic(conversation) {
    if (!conversation) return null;
    return conversation.topics.find((topic) => topic.id === conversation.activeTopicId) || null;
  }

  function deriveTitle(message) {
    let text = cleanText(message, MAX_TITLE_CHARS);
    text = text.replace(
      /^(please|can you|could you|would you|i want to|i need to|help me|let's|lets|من فضلك|ممكن|أريد|أريد أن|اريد|ساعدني)\s+/i,
      '',
    );
    return text || 'New topic';
  }

  function createTopic(conversation, message) {
    const topic = {
      id: `topic_${conversation.nextTopic++}`,
      title: deriveTitle(message),
      status: 'active',
      createdAt: current(),
      updatedAt: current(),
      lastAt: current(),
      keywords: keywordList(message),
      points: [],
      corrections: [],
      turns: [],
      products: new Map(),
      categories: new Map(),
      /* Ids the tools returned for this topic, in arrival order. Separate from
         the product rows: a search whose results are not recorded as rows
         (a duplicate check kept internal) still showed the model real ids,
         and those ids must be targetable all the same. */
      seenIds: new Map(),
      plans: [],
      clarifications: [],
      pendingRequest: null,
      currentCategory: null,
      stage: 'idle',
      summary: '',
    };
    conversation.topics.push(topic);
    if (conversation.topics.length > maxTopics) {
      const removable = conversation.topics.find(
        (candidate) => candidate.id !== topic.id && candidate.id !== conversation.activeTopicId,
      );
      if (removable) {
        const index = conversation.topics.indexOf(removable);
        conversation.topics.splice(index, 1);
      }
    }
    return topic;
  }

  function mergeKeywords(topic, value) {
    const merged = new Set(topic.keywords);
    for (const token of keywordList(value)) merged.add(token);
    topic.keywords = [...merged].slice(-MAX_KEYWORDS);
  }

  function addPoint(topic, message) {
    const text = cleanText(message, MAX_POINT_CHARS);
    if (!text) return;
    const normalised = normalise(text);
    const existing = topic.points.find((point) => point.normalised === normalised);
    if (existing) {
      existing.count += 1;
      existing.at = current();
    } else {
      topic.points.push({ text, normalised, at: current(), count: 1 });
      if (topic.points.length > MAX_POINTS) topic.points.shift();
    }

    if (hasPhrase(message, CORRECTION_PHRASES)) {
      const correction = topic.corrections.find((item) => item.normalised === normalised);
      if (correction) {
        correction.count += 1;
        correction.at = current();
      } else {
        topic.corrections.push({ text, normalised, at: current(), count: 1 });
        if (topic.corrections.length > MAX_CORRECTIONS) topic.corrections.shift();
      }
    }
  }

  function addTurn(topic, role, text) {
    const content = cleanText(text, MAX_TEXT_CHARS);
    if (!content) return;
    topic.turns.push({ role, text: content, at: current() });
    if (topic.turns.length > MAX_TURNS) topic.turns.shift();
  }

  function addProduct(topic, item) {
    if (!item) return;
    const id = cleanText(item.id, 80);
    if (!id) return;
    /* Delete then set, so a re-seen row moves to the end: the map's order is
       recency, and the row evicted when the cache is full is the one nobody
       has looked at lately. seenTurn is what recordFor joins on - only the
       latest search for a product can name one. */
    topic.products.delete(id);
    topic.products.set(id, {
      id,
      name: cleanText(item.name, 160),
      category: cleanText(item.category, 120),
      price: item.sellingPrice,
      cost: item.costPrice,
      stock: item.stock,
      unit: cleanText(item.unit, 40),
      barcode: cleanText(item.barcode, 80),
      sku: cleanText(item.sku, 80),
      seenTurn: topic.ingestSeq || 0,
    });
    if (topic.products.size > MAX_PRODUCTS) {
      const oldest = topic.products.keys().next().value;
      if (oldest) topic.products.delete(oldest);
    }
  }

  function addCategory(topic, item) {
    if (!item) return;
    const id = cleanText(item.id, 80);
    if (!id) return;
    topic.categories.delete(id);
    topic.categories.set(id, {
      id,
      name: cleanText(item.name, 160),
      description: cleanText(item.description, 240),
      itemCount: item.itemCount,
      seenTurn: topic.ingestSeq || 0,
    });
    if (topic.categories.size > MAX_CATEGORIES) {
      const oldest = topic.categories.keys().next().value;
      if (oldest) topic.categories.delete(oldest);
    }
  }

  /* The category a conversation is working in is a decision, not a guess. It
     is set when the user answers a category question and when a plan creates
     or names one. Follow-up products inherit it, so the assistant never has to
     ask "which category?" again after it was already answered. */
  function setCurrentCategory(topic, name, id) {
    const cleanName = cleanText(name, 160);
    if (!topic || !cleanName) return;
    topic.currentCategory = {
      id: cleanText(id, 80) || (topic.currentCategory && topic.currentCategory.id) || '',
      name: cleanName,
      at: current(),
    };
  }

  function matchingCategory(topic, answer) {
    const value = normalise(answer);
    if (!value) return null;
    for (const category of topic.categories.values()) {
      const name = normalise(category.name);
      if (!name || name.length < 2) continue;
      if (value === name || value.includes(name) || name.includes(value)) return category;
    }
    return null;
  }

  function isCategoryAnswer(item) {
    return slotForClarification(item) === 'category';
  }

  /* A finite choice is a decision, not a sentence. The reply either is the
     choice the operator pressed or it is ordinary text, and only the second
     is ever re-read as prose. A declined option carries no value key at all,
     which is what makes it structurally impossible to read back as a name
     later. Returns null when the question had no options or the reply
     matches none of them.

     Three ways in, in this order:
       1. the answer object the card sent back (ids, never wording);
       2. a typed reply that equals the label or the value of one option;
       3. nothing - the reply stays text for the model to interpret. */
  /* A numeric slot stores the canonical Latin string the normaliser reads;
     a value it cannot read leaves the question pending rather than being
     guessed at, and a non-numeric slot is untouched. */
  function canonicalNumber(slot, value) {
    if (!NUMERIC_SLOTS.has(slot)) return cleanText(value, 160);
    const parsed = parseNumberInput(value);
    return parsed.ok ? parsed.value : null;
  }

  function resolveClarification(pending, message, answer) {
    if (!pending) return null;
    const options = Array.isArray(pending.options) ? pending.options : [];
    const slot = slotForClarification(pending);
    const labelOf = (option) => (typeof option === 'string' ? option : option && option.label) || '';
    const valueOf = (option) => (typeof option === 'string'
      ? option
      : (option && (option.value || option.label))) || '';
    const noneOf = (option) => !!(option && typeof option === 'object' && option.none);
    const recordOf = (option) => {
      const record = option && typeof option === 'object' && option.record;
      return record && record.id ? record : null;
    };

    if (answer && typeof answer === 'object') {
      const sentId = cleanText(answer.clarificationId, 60);
      /* A card from an earlier question is not an answer to this one.
         Returning nothing is deliberate: matching a stale click against the
         new options would decide a question the operator never saw. */
      if (!sentId || sentId !== cleanText(pending.id, 60)) return null;
      const chosen = options.find((option) =>
        option && typeof option === 'object' && option.id &&
        option.id === cleanText(answer.optionId, 40));
      if (chosen) {
        const label = cleanText(chosen.label, 80);
        if (chosen.none) return { slot, kind: 'none', value: '', label };
        if (chosen.action === 'attach') {
          const ids = imageIds(answer);
          if (!ids.length) return null;
          return { slot: slot || 'image', kind: 'attachment', value: '', ids, label };
        }
        const record = recordOf(chosen);
        const chosenValue = canonicalNumber(slot, chosen.value || chosen.label);
        if (chosenValue === null) return null;
        return {
          slot,
          kind: record ? 'record' : 'value',
          value: chosenValue,
          id: record ? record.id : '',
          entity: record ? record.entity : '',
          label,
        };
      }
      const ids = imageIds(answer);
      if (ids.length && (slot === 'image' || !slot)) {
        return { slot: 'image', kind: 'attachment', value: '', ids, label: '' };
      }
      const value = cleanText(answer.value, 160);
      /* The question's own slot is the authority. A client-supplied slot that
         disagrees decides a field the model never asked for, an unrecognisable
         one settles nothing, and a value with no slot behind it stays text for
         the model to interpret. */
      const rawSlot = cleanText(answer.slot, 40);
      const answeredSlot = normaliseSlot(rawSlot);
      if (value && slot && (!rawSlot || (answeredSlot && answeredSlot === slot))) {
        const canonical = canonicalNumber(slot, value);
        if (canonical === null) return null;
        return { slot, kind: 'value', value: canonical, label: canonical };
      }
      return null;
    }

    if (!options.length) return null;
    const text = normalise(message);
    if (!text) return null;
    const hits = options.filter((option) => {
      const label = normalise(labelOf(option));
      const value = normalise(valueOf(option));
      return !!label && (label === text || (!!value && value === text));
    });
    if (hits.length !== 1) return null;
    const option = hits[0];
    const label = cleanText(labelOf(option), 80);
    if (noneOf(option)) return { slot, kind: 'none', value: '', label };
    const record = recordOf(option);
    const matchedValue = canonicalNumber(slot, valueOf(option));
    if (matchedValue === null) return null;
    return {
      slot,
      kind: record ? 'record' : 'value',
      value: matchedValue,
      id: record ? record.id : '',
      entity: record ? record.entity : '',
      label,
    };
  }

  function imageIds(answer) {
    const list = Array.isArray(answer && answer.attachmentIds) ? answer.attachmentIds : [];
    return list
      .map((id) => cleanText(id, 80))
      .filter(Boolean)
      .slice(0, 8);
  }

  /* An image the operator attached for this request. The draft owns it, with
     an explicit status, so the image question is never asked again after it
     is answered and an attachment from an earlier request is never reused. */
  function setImageStatus(topic, status, attachmentIds) {
    const draft = topic && topic.pendingRequest && topic.pendingRequest.draft;
    if (!draft || typeof draft !== 'object') return null;
    const ids = (Array.isArray(attachmentIds) ? attachmentIds : [])
      .map((id) => cleanText(id, 80))
      .filter(Boolean)
      .slice(0, 8);
    if (status === 'attached' && !ids.length) return draft.image || null;
    draft.image = { status, attachmentIds: ids };
    return draft.image;
  }

  /* The upload answered the image question, so the card that asked for it is
     settled too: left live, a later "no image" click would overwrite the
     picture that just arrived. */
  function answerImageQuestion(topic) {
    if (!topic) return null;
    const card = [...topic.clarifications].reverse().find((item) =>
      item.status === 'pending' && slotForClarification(item) === 'image');
    if (!card) return null;
    return markClarification(topic, '', 'answered', null, cleanText(card.id, 60));
  }

  function noteImage(conversationId, status, attachmentIds, { onlyIfUnset = false } = {}) {
    const conversation = ensureConversation(conversationId);
    if (!conversation) return null;
    const topic = activeTopic(conversation);
    const draft = topic && topic.pendingRequest && topic.pendingRequest.draft;
    /* A picture already recorded is only replaced by a click on the image
       card, never by a plain upload. A question still waiting for a picture
       is open, and so is a decline the operator now answers with a real file:
       "actually, here is the photo" is a deliberate act. */
    if (onlyIfUnset && draft && typeof draft === 'object' && draft.image &&
        draft.image.status === 'attached') return null;
    const recorded = setImageStatus(topic, status, attachmentIds);
    if (status === 'attached' && recorded) answerImageQuestion(topic);
    return recorded;
  }

  /* How a settled answer is written into the prompt. A decision is rendered
     from its meaning rather than its wording, so a declined option reads as
     an empty field instead of a name, and a record choice carries the id the
     system resolved instead of leaving the model to pick one. */
  function settledAnswer(item) {
    if (!item) return '';
    const decision = item.decision;
    if (!decision) return `${item.question} -> ${item.answer}`;
    const slot = decision.slot || item.question;
    if (decision.kind === 'none') return `${slot} = none (leave empty)`;
    if (decision.kind === 'attachment') {
      const ids = Array.isArray(decision.ids) ? decision.ids.filter(Boolean) : [];
      return `${slot} = attached${ids.length ? ` (attachment ${ids.join(', ')})` : ''}`;
    }
    if (decision.kind === 'record' && decision.id) {
      return `${slot} = ${decision.value} (id ${decision.id})`;
    }
    return `${slot} = ${decision.value}`;
  }

  function addPlan(topic, plan) {
    if (!plan || !plan.id) return;
    const steps = (Array.isArray(plan.steps) ? plan.steps : []).map((step) => {
      const fields = (step && step.fields) || {};
      return {
        id: step.id,
        action: step.action,
        label: step.label,
        target: step.target,
        name: fields.name,
        before: step.before && step.before.name,
        resultId: step.resultId,
        resultName: step.resultName,
        categoryName: typeof fields.category_name === 'string' ? fields.category_name : '',
        categoryId: typeof fields.category_id === 'string' ? fields.category_id : '',
      };
    });
    const existing = topic.plans.find((item) => item.id === plan.id);
    const record = {
      id: plan.id,
      status: plan.status || 'pending',
      steps,
      createdAt: (existing && existing.createdAt) || current(),
      updatedAt: current(),
    };
    if (existing) Object.assign(existing, record);
    else {
      topic.plans.push(record);
      if (topic.plans.length > MAX_PLANS) topic.plans.shift();
    }
    for (const step of steps) {
      if (step.action === 'update_product' && step.target && step.before) {
        addProduct(topic, { id: step.target, name: step.before });
      }
      if (step.action === 'create_product' && (step.resultId || step.name)) {
        addProduct(topic, {
          id: step.resultId || `plan:${plan.id}:${step.id}`,
          name: step.resultName || step.name,
        });
      }
      if (step.action === 'create_category' && (step.resultId || step.name)) {
        addCategory(topic, {
          id: step.resultId || `plan:${plan.id}:${step.id}`,
          name: step.resultName || step.name,
        });
        setCurrentCategory(topic, step.resultName || step.name, step.resultId);
      }
      if (step.categoryName && step.action !== 'create_category') {
        setCurrentCategory(topic, step.categoryName, step.categoryId);
      }
    }
    topic.stage = plan.status === 'completed'
      ? 'done'
      : plan.status === 'cancelled'
        ? 'cancelled'
        : plan.status === 'failed'
          ? 'failed'
          : 'awaiting_confirmation';
  }

  function addClarification(topic, result) {
    if (!result || !result.question) return;
    /* The local product flow keeps its structured draft here. It is local
       working state: never a shop record, never synced, and cleared when the
       plan is proposed or the request is abandoned. */
    const draft = result.draft && typeof result.draft === 'object' ? result.draft : null;
    for (const item of topic.clarifications) {
      if (item.status === 'pending') item.status = 'superseded';
    }
    const note = cleanText(result.pending, MAX_TEXT_CHARS);
    const missing = (Array.isArray(result.missing) ? result.missing : [])
      .map((item) => cleanText(item, 60))
      .filter(Boolean)
      .slice(0, 8);
    topic.clarifications.push({
      /* Stable identity for the options, so a click can name the exact choice
         it was made on instead of being re-read from its wording. Cards are
         presented by ask-slots, which mints this id; the fallback keeps an
         unpresented result (a test, an older caller) resolvable too. */
      id: cleanText(result.id, 60) || `c${Date.now().toString(36)}${topic.clarifications.length}`,
      question: cleanText(result.question, 300),
      /* The one field this question decides. Absent when neither the model,
         the field labels nor the question wording name one, which keeps the
         older free-text path working. */
      slot: normaliseSlot(result.slot),
      /* Kept as objects rather than label strings: `value` is what the button
         sends, `none` marks the option that leaves the field empty, `action`
         says what the page does with it and `record` is a system-resolved id.
         `id` comes from the position here when the card did not carry one. */
      options: (Array.isArray(result.options) ? result.options : [])
        .slice(0, 4)
        .map((option, index) => ({
          id: cleanText(option && option.id, 40) || `o${index + 1}`,
          label: cleanText(option && option.label, 80),
          value: cleanText(option && option.value, 160),
          none: !!(option && option.none),
          action: cleanText(option && option.action, 20),
          record: option && option.record && option.record.id
            ? {
                entity: cleanText(option.record.entity, 20) || 'product',
                id: cleanText(option.record.id, 80),
              }
            : null,
        }))
        .filter((option) => option.label),
      note,
      missing,
      status: 'pending',
      at: current(),
    });
    if (topic.clarifications.length > MAX_CLARIFICATIONS) topic.clarifications.shift();

    /* The model is not required to send a draft note. Even without one, the
       original create/update request is the safest description of what is
       unfinished, so keep it on the topic until a plan is proposed. */
    if (!topic.pendingRequest) {
      const lastWrite = [...topic.points].reverse().find((point) => looksLikeWriteRequest(point.text));
      topic.pendingRequest = {
        text: lastWrite ? lastWrite.text : '',
        at: current(),
        note: '',
        asked: false,
        draft: null,
      };
    }
    if (note) topic.pendingRequest.note = note;
    if (draft) topic.pendingRequest.draft = draft;
    topic.pendingRequest.asked = true;
    topic.stage = 'collecting';
  }

  function noteDraft(conversationId, draft) {
    const conversation = ensureConversation(conversationId);
    const topic = activeTopic(conversation);
    if (!topic) return null;
    if (!topic.pendingRequest) {
      const lastWrite = [...topic.points].reverse().find((point) => looksLikeWriteRequest(point.text));
      topic.pendingRequest = {
        text: lastWrite ? lastWrite.text : '',
        at: current(),
        note: '',
        asked: false,
        draft: null,
      };
    }
    topic.pendingRequest.draft = draft && typeof draft === 'object'
      ? JSON.parse(JSON.stringify(draft))
      : null;
    return topic.pendingRequest.draft;
  }

  function markClarification(topic, message, status, answer, clarificationId = '') {
    if (!topic) return null;
    const wanted = cleanText(clarificationId, 60);
    /* Without an id the latest open question is the one being answered - that
       is the prose path. With an id exactly that card is settled, even when a
       newer question superseded it: clicking the older one must not retire the
       newer one, and the newer one must not swallow the older click. */
    const pending = [...topic.clarifications].reverse().find((item) =>
      (item.status === 'pending' || (!!wanted && item.status === 'superseded')) &&
      (!wanted || cleanText(item.id, 60) === wanted));
    if (!pending) return null;
    let resolved = null;
    pending.status = status || 'answered';
    if (pending.status === 'answered') {
      pending.answer = cleanText(message, 200);
      pending.answeredAt = current();

      /* A finite choice is decided by the option that was offered, not by
         reading the reply as prose. Only an unmatched reply stays text for
         the model to interpret. */
      const decision = resolveClarification(pending, pending.answer, answer);
      if (decision) pending.decision = decision;
      resolved = decision || null;

      /* The category is a fact about the shop, so a finite choice may only
         ever name one that exists: it was one of a small set of buttons, so
         its wording is not evidence of a record. "لا فئة" declines it and a
         name nobody has created is not one either; storing either would put a
         category that does not exist into the prompt, and the model would
         obediently write it into the plan. Free text keeps the older
         behaviour, where a typed name carries the request forward until the
         plan creates it. */
      const asksCategory = isCategoryAnswer(pending);
      const declined = decision && decision.kind === 'none';
      const wasChoice = Array.isArray(pending.options) && pending.options.length > 0;
      if (asksCategory && !declined) {
        if (decision && decision.kind === 'record' && decision.entity !== 'category') {
          /* A product was picked for a category question; naming it a
             category would be inventing a record. Leave the category alone. */
        } else if (decision && decision.kind === 'record' && decision.id) {
          setCurrentCategory(topic, decision.value, decision.id);
        } else {
          const source = decision && decision.kind === 'value' ? decision.value : pending.answer;
          const known = matchingCategory(topic, source);
          if (known) setCurrentCategory(topic, known.name, known.id || '');
          else if (!wasChoice) setCurrentCategory(topic, source, '');
        }
      }

      /* An image answer writes the draft's explicit image status, which is
         what stops the assistant asking for the picture a second time and
         what the local product path builds its plan images from. */
      if (decision && decision.slot === 'image') {
        if (decision.kind === 'attachment') setImageStatus(topic, 'attached', decision.ids);
        else if (decision.kind === 'none') setImageStatus(topic, 'none', []);
      }

      /* The old draft note was written before this answer and can still say
         "category not set" or list a field that has just been supplied. The
         answer and the original request are the truth now; keeping the stale
         note makes the model ask again. */
      if (topic.pendingRequest) {
        topic.pendingRequest.note = '';
        topic.pendingRequest.answers = topic.clarifications
          .filter((item) => item.status === 'answered' && item.answer)
          .slice(-6)
          /* The decision travels with the answer so the prompt can render it
             by meaning. Without it a declined option would still print as the
             label the user clicked. */
          .map((item) => ({
            question: item.question,
            answer: item.answer,
            decision: item.decision || null,
          }));
      }
    }
    return resolved;
  }

  function ingestToolCalls(topic, toolCalls) {
    const calls = Array.isArray(toolCalls) ? toolCalls : [];
    /* One number for the whole batch: every row one search turn returns
       shares it, so a card minted after that turn may name any of them, while
       rows from earlier turns are older and cannot. */
    const bringsRows = calls.some((call) => {
      const result = call && call.metadata && call.metadata.posnic;
      return !!result && (result.kind === 'product_search' ||
        result.kind === 'product_list' || result.kind === 'category_list');
    });
    if (bringsRows) topic.ingestSeq = (topic.ingestSeq || 0) + 1;
    for (const call of calls) {
      const result = call && call.metadata && call.metadata.posnic;
      if (!result) continue;
      if (result.kind === 'product_search' || result.kind === 'product_list') {
        const results = Array.isArray(result.results) ? result.results : [];
        for (const item of results) addProduct(topic, item);
        /* One product points at one category. A long search result does not:
           its first row may be a coincidence, not the shelf being discussed. */
        if (results.length === 1 && results[0] && results[0].category) {
          const known = matchingCategory(topic, results[0].category);
          setCurrentCategory(
            topic,
            known ? known.name : results[0].category,
            known ? known.id : '',
          );
        }
      } else if (result.kind === 'category_list') {
        for (const item of Array.isArray(result.categories) ? result.categories : []) addCategory(topic, item);
      } else if (result.kind === 'write_plan') {
        addPlan(topic, result.plan);
        topic.pendingRequest = null;
        for (const item of topic.clarifications) {
          if (item.status === 'pending') item.status = 'answered';
        }
      } else if (result.kind === 'clarify') {
        addClarification(topic, result);
      }
    }
    refreshTitle(topic);
  }

  function refreshTitle(topic) {
    if (!topic || (topic.title && topic.title !== 'New topic')) return;
    const products = [...topic.products.values()];
    const categories = [...topic.categories.values()];
    if (products.length === 1) topic.title = `Product: ${products[0].name}`;
    else if (categories.length === 1) topic.title = `Category: ${categories[0].name}`;
  }

  function productLine(product) {
    const parts = [product.name || 'Unnamed product'];
    if (product.id) parts.push(`id ${product.id}`);
    if (Number.isFinite(Number(product.price))) parts.push(`price ${product.price}`);
    if (Number.isFinite(Number(product.stock))) parts.push(`stock ${product.stock}`);
    if (product.unit) parts.push(`unit ${product.unit}`);
    if (product.barcode) parts.push(`barcode ${product.barcode}`);
    if (product.sku) parts.push(`sku ${product.sku}`);
    return parts.join(' | ');
  }

  function updateSummary(topic) {
    if (!topic) return;
    const parts = [];
    if (topic.points.length) {
      parts.push(`User: ${topic.points[0].text}`);
      if (topic.points.length > 1) parts.push(`Latest: ${topic.points[topic.points.length - 1].text}`);
    }
    const products = [...topic.products.values()].slice(-4);
    if (products.length) parts.push(`Products: ${products.map(productLine).join('; ')}`);
    const categories = [...topic.categories.values()].slice(-4);
    if (categories.length) {
      parts.push(`Categories: ${categories.map((category) => category.name).join(', ')}`);
    }
    if (topic.currentCategory && topic.currentCategory.name) {
      parts.push(`Current category: ${topic.currentCategory.name}`);
    }
    if (topic.plans.length) {
      parts.push(`Plans: ${topic.plans.slice(-3).map((plan) => `${plan.id} ${plan.status}`).join(', ')}`);
    }
    const answered = topic.clarifications.filter((item) => item.status === 'answered').slice(-3);
    if (answered.length) {
      parts.push(`Answered: ${answered.map(settledAnswer).join('; ')}`);
    }
    const corrections = topic.corrections.slice(-3);
    if (corrections.length) parts.push(`Corrections: ${corrections.map((item) => item.text).join('; ')}`);
    const lastAssistant = [...topic.turns].reverse().find((turn) => turn.role === 'assistant');
    if (lastAssistant) parts.push(`Assistant: ${lastAssistant.text}`);
    topic.summary = cleanText(parts.join(' '), MAX_SUMMARY_CHARS);
  }

  function scoreTopic(topic, forms, text) {
    if (!topic) return 0;
    let score = 0;
    const keywords = new Set(topic.keywords);
    for (const form of forms) {
      if (keywords.has(form)) score += 1;
    }
    for (const product of topic.products.values()) {
      const name = normalise(product.name);
      if (name && name.length >= 2 && text.includes(name)) score += 3;
      if (product.barcode && text.includes(normalise(product.barcode))) score += 3;
      if (product.sku && text.includes(normalise(product.sku))) score += 3;
    }
    for (const category of topic.categories.values()) {
      const name = normalise(category.name);
      if (name && name.length >= 2 && text.includes(name)) score += 2;
    }
    for (const point of topic.points) {
      if (point.normalised && text.includes(point.normalised)) score += 2;
    }
    if (topic.status === 'active') score += 0.25;
    if (current() - topic.lastAt < 10 * 60 * 1000) score += 0.25;
    return score;
  }

  function hasEntity(topic) {
    return !!(topic && (topic.products.size || topic.categories.size || topic.plans.length));
  }

  function isActionFollowUp(message, topic) {
    if (!hasEntity(topic)) return false;
    if (hasPhrase(message, NEW_ENTITY_PHRASES)) return false;
    return hasPhrase(message, ACTION_PHRASES);
  }

  function beginTurn(conversationId, text, { answer = null } = {}) {
    const conversation = ensureConversation(conversationId);
    if (!conversation) return null;
    const message = cleanText(text, 4000);
    if (!message) {
      const topic = activeTopic(conversation);
      return topic ? {
        conversationId: conversation.id,
        topicId: topic.id,
        topicTitle: topic.title,
        switched: false,
        resumed: false,
        reason: 'empty',
        stage: topic.stage,
      } : null;
    }

    const forms = tokenForms(message);
    const normalised = normalise(message);
    const previous = activeTopic(conversation);
    const scored = conversation.topics
      .filter((topic) => topic !== previous)
      .map((topic) => ({ topic, score: scoreTopic(topic, forms, normalised) }))
      .sort((left, right) => right.score - left.score);
    const best = scored[0];
    const activeScore = previous ? scoreTopic(previous, forms, normalised) : 0;
    const newSignal = hasPhrase(message, NEW_TOPIC_PHRASES);
    const backSignal = hasPhrase(message, BACK_PHRASES);
    const continuation = hasPhrase(message, CONTINUATION_PHRASES) ||
      SHORT_REPLY_RE.test(normalised) ||
      isNotImportant(normalised) ||
      GREETING_RE.test(normalised);
    const actionFollowUp = isActionFollowUp(message, previous);
    const newEntity = hasPhrase(message, NEW_ENTITY_PHRASES) || CREATE_ENTITY_RE.test(message);
    /* A category the user already settled belongs to this topic, not to one
       product. Adding the next product is a continuation while that category
       is current, otherwise the assistant forgets the shelf it was just told
       about and asks again. An explicit topic change is handled above. */
    const carriedCategory = !!(
      previous && previous.currentCategory && previous.currentCategory.name &&
      !newSignal && !backSignal
    );
    const cancellation = isCancellation(message) && !(newSignal && !backSignal);
    const wasPending = !!(previous && previous.pendingRequest);
    const waitingClarification = previous
      ? [...previous.clarifications].reverse().find((item) => item.status === 'pending')
      : null;
    const acknowledgement = ACK_ONLY_RE.test(normalised) &&
      !!(waitingClarification &&
        Array.isArray(waitingClarification.missing) &&
        waitingClarification.missing.length);
    const correction = looksLikeCorrection(message);
    const question = looksLikeQuestion(message);
    /* A read question in the middle of a task pauses it. It is not the answer
       to the pending question and it must not replace the pending request. */
    const sideQuestion = wasPending && !newSignal && !newEntity && !cancellation &&
      question && !correction;
    /* A card click carries the id of the card it answers. It is an answer,
       never a new request: a label such as "من غير سعر" reads like a write
       request, and without this guard the request is replaced and the card
       superseded before the click can settle it. An older card that a newer
       question superseded is still on screen, so it is matched too - the
       click names the exact card, whichever one it is. */
    const sentCardId = answer && typeof answer === 'object'
      ? cleanText(answer.clarificationId, 60)
      : '';
    const liveCard = sentCardId && previous
      ? [...previous.clarifications].reverse().find((item) =>
        (item.status === 'pending' || item.status === 'superseded') &&
        cleanText(item.id, 60) === sentCardId)
      : null;
    const cardClick = !!liveCard;
    /* The first create/update request also creates a pending draft. A short
       answer continues it; a new write action starts a new request unless it
       is a correction such as "change the price to 50". A bare "تمام" while
       fields are still missing is an acknowledgement, not a value. */
    const pendingAnswer = wasPending && !newSignal && !newEntity && !cancellation &&
      !sideQuestion && !acknowledgement &&
      (!looksLikeWriteRequest(message) || correction || cardClick);

    let topic = previous;
    let switched = false;
    let resumed = false;
    let reason = 'continue';

    if (!previous) {
      topic = createTopic(conversation, message);
      switched = true;
      reason = 'new';
    } else if (newSignal && !backSignal) {
      topic = createTopic(conversation, message);
      switched = true;
      reason = 'new';
    } else if (backSignal && best && best.score >= 1.5) {
      topic = best.topic;
      switched = topic.id !== previous.id;
      resumed = switched;
      reason = 'resume';
    } else if (best && best.score >= 2.5 && activeScore <= 0.5 && !continuation &&
      !actionFollowUp && !pendingAnswer && !sideQuestion) {
      topic = best.topic;
      switched = true;
      resumed = true;
      reason = 'related';
    } else if (newEntity && !carriedCategory) {
      topic = createTopic(conversation, message);
      switched = true;
      reason = 'new';
    } else if (actionFollowUp || pendingAnswer || (newEntity && carriedCategory)) {
      reason = 'follow-up';
    } else if (!continuation && !actionFollowUp && !sideQuestion && activeScore <= 0 &&
      forms.size >= 2 && !GREETING_RE.test(normalised)) {
      topic = createTopic(conversation, message);
      switched = true;
      reason = 'new';
    }
    if (sideQuestion && !switched) reason = 'side-question';
    if (acknowledgement && !switched) reason = 'acknowledgement';

    if (previous && switched && previous !== topic) {
      previous.status = 'archived';
      /* Leaving a task for another topic pauses it, so it can be resumed.
         "سيبك من ده" is an explicit abandon and clears it. A plan waiting for
         confirmation stays waiting; its card is still the decision. */
      if (isAbandon(message)) {
        previous.pendingRequest = null;
        previous.stage = 'cancelled';
        for (const item of previous.clarifications) {
          if (item.status === 'pending') item.status = 'cancelled';
        }
      } else if (previous.pendingRequest &&
        (previous.stage === 'collecting' || previous.stage === 'paused' || previous.stage === 'idle')) {
        previous.stage = 'paused';
      }
    }
    if (!topic) topic = createTopic(conversation, message);
    topic.status = 'active';
    topic.lastAt = current();
    topic.updatedAt = current();
    conversation.activeTopicId = topic.id;
    conversation.updatedAt = current();

    /* An id the operator pasted is part of the conversation just as much as
       one a tool returned, so the plan allow-list accepts it; an id the model
       produced on its own is still refused. A longer hex run is not claimed
       window by window - only a whole 24-character id counts. */
    const typedIds = message.match(/(?<![0-9a-f])[0-9a-f]{24}(?![0-9a-f])/gi);
    if (typedIds) noteSeen(conversationId, typedIds.map((value) => ({ id: value })));

    if (cancellation) {
      topic.pendingRequest = null;
      topic.stage = 'cancelled';
      for (const item of topic.clarifications) {
        if (item.status === 'pending') item.status = 'cancelled';
      }
    } else if (sideQuestion) {
      if (topic.stage === 'collecting' || topic.stage === 'paused') topic.stage = 'paused';
    } else if (!sideQuestion && !cardClick && looksLikeWriteRequest(message) &&
      (!topic.pendingRequest || newEntity || !pendingAnswer)) {
      topic.pendingRequest = {
        text: cleanText(message, MAX_TEXT_CHARS),
        at: current(),
        note: '',
        asked: false,
        draft: null,
      };
      for (const item of topic.clarifications) {
        if (item.status === 'pending') item.status = 'superseded';
      }
      topic.stage = 'collecting';
    } else if (pendingAnswer && topic.stage !== 'awaiting_confirmation') {
      topic.stage = 'collecting';
    }

    /* The click matched above is resolved against the topic this turn stayed
       in. If the turn switched topics the card belongs elsewhere and settles
       nothing; otherwise the named card is the one answered, whether a newer
       question superseded it or not. */
    const targetCard = sentCardId
      ? [...topic.clarifications].reverse().find((item) =>
        (item.status === 'pending' || item.status === 'superseded') &&
        cleanText(item.id, 60) === sentCardId)
      : null;
    const structuredAnswer = !!(sentCardId && targetCard);
    /* An answer that carries card ids but decides nothing must not retire the
       question: a click from a card that no longer exists, a value tagged with
       a slot this question never asked for, an attachment with no ids. In each
       case the card stays exactly as it was, so the operator can still answer
       it - marking it answered would leave a dead card and nothing decided.
       An answer object without ids is ordinary text and keeps the older
       behaviour. */
    const unusableCard = !!sentCardId && !resolveClarification(targetCard, message, answer);
    /* A settled decision tells the local flow which slot this turn answered,
       so its click label is never parsed as a sentence. pendingAnswer stays
       text-based: this turn still answers the pending request. */
    let answered = null;
    if ((pendingAnswer || structuredAnswer) && !switched && !unusableCard) {
      const decision = markClarification(topic, message, 'answered',
        structuredAnswer ? answer : null, sentCardId);
      if (decision && decision.slot) answered = { slot: decision.slot, kind: decision.kind };
    }
    addPoint(topic, message);
    mergeKeywords(topic, message);
    addTurn(topic, 'user', message);
    updateSummary(topic);

    return {
      conversationId: conversation.id,
      topicId: topic.id,
      topicTitle: topic.title,
      switched,
      resumed,
      reason,
      stage: topic.stage,
      writeRequest: !sideQuestion && !cancellation && looksLikeWriteRequest(message),
      pendingAnswer: pendingAnswer && !switched,
      answered,
      sideQuestion: sideQuestion && !switched,
      acknowledgement: acknowledgement && !switched,
      contextChange: switched || sideQuestion || cancellation || isAbandon(message),
    };
  }

  function completeTurn(conversationId, text, toolCalls) {
    const conversation = ensureConversation(conversationId);
    if (!conversation) return null;
    const topic = activeTopic(conversation);
    if (!topic) return null;
    const reply = cleanText(text, MAX_TEXT_CHARS);
    if (reply) addTurn(topic, 'assistant', reply);
    ingestToolCalls(topic, toolCalls);
    updateSummary(topic);
    topic.updatedAt = current();
    topic.lastAt = current();
    conversation.updatedAt = current();
    return { topicId: topic.id, title: topic.title, stage: topic.stage };
  }

  function notePlan(conversationId, plan, status) {
    const conversation = ensureConversation(conversationId);
    if (!conversation || !plan) return null;
    let topic = conversation.topics.find((candidate) =>
      candidate.plans.some((item) => item.id === plan.id));
    if (!topic) topic = activeTopic(conversation);
    if (!topic) return null;
    const existing = topic.plans.find((item) => item.id === plan.id);
    if (existing) {
      existing.status = status || plan.status || existing.status;
      existing.updatedAt = current();
    } else {
      addPlan(topic, plan);
      const added = topic.plans.find((item) => item.id === plan.id);
      if (added) added.status = status || plan.status || added.status;
    }
    if (status === 'completed' || status === 'cancelled' || plan.status === 'completed' || plan.status === 'cancelled') {
      topic.pendingRequest = null;
    }
    if (status === 'completed' || plan.status === 'completed') topic.stage = 'done';
    else if (status === 'cancelled' || plan.status === 'cancelled') topic.stage = 'cancelled';
    else if (status === 'failed' || plan.status === 'failed') topic.stage = 'failed';
    else if (topic.stage !== 'done' && topic.stage !== 'cancelled') {
      topic.stage = 'awaiting_confirmation';
    }
    addPoint(topic, `Plan ${plan.id} ${status || plan.status || 'updated'}`);
    updateSummary(topic);
    conversation.updatedAt = current();
    return { topicId: topic.id, title: topic.title, stage: topic.stage };
  }

  function contextFor(conversationId, { full = false, message = '' } = {}) {
    const conversation = conversations.get(key(conversationId));
    const topic = activeTopic(conversation);
    if (!conversation || !topic) return '';
    const currentMessage = normalise(message);
    const lines = ['[Conversation memory]'];
    lines.push(`Active topic: ${topic.title}`);
    const stageGuidance = STAGE_GUIDANCE[topic.stage];
    if (stageGuidance) lines.push(stageGuidance);
    if (topic.summary) lines.push(`Summary: ${topic.summary}`);

    if (topic.pendingRequest && (topic.pendingRequest.text || topic.pendingRequest.note)) {
      const resumed = !!(topic.pendingRequest.asked || topic.pendingRequest.note);
      lines.push(resumed
        ? 'Unfinished request (continue it; do not search or start over):'
        : 'Request in progress (search first for a duplicate, then continue):');
      if (topic.pendingRequest.text) lines.push(`- Request: ${topic.pendingRequest.text}`);
      if (topic.pendingRequest.note) lines.push(`- Draft: ${topic.pendingRequest.note}`);
      const settled = (Array.isArray(topic.pendingRequest.answers) ? topic.pendingRequest.answers : [])
        .slice(-6);
      if (settled.length) {
        lines.push('Answered for this request (settled; never ask again):');
        for (const item of settled) lines.push(`- ${settledAnswer(item)}`);
      }
      const waiting = [...topic.clarifications].reverse().find((item) => item.status === 'pending');
      if (waiting) {
        lines.push(`- Waiting for the answer to: ${waiting.question}`);
        const lastUser = [...topic.turns].reverse().find((turn) => turn.role === 'user');
        if (lastUser && ACK_ONLY_RE.test(normalise(lastUser.text)) &&
            Array.isArray(waiting.missing) && waiting.missing.length) {
          lines.push('- The last message was only an acknowledgement; the question above is still unanswered. Ask for the remaining values once.');
        }
      }
      if (resumed) {
        lines.push('A short answer that supplies the missing value, or an explicit skip such as "مش مهم", answers this request. A bare acknowledgement is not a value; ask for the remaining values once. Do not search or change topic.');
      }
    }

    if (topic.currentCategory && topic.currentCategory.name) {
      lines.push(
        `Current category: ${topic.currentCategory.name}` +
        (topic.currentCategory.id ? ` | id ${topic.currentCategory.id}` : '') +
        '. Use it for follow-up products in this topic unless the user names another category. Do not ask for it again.',
      );
    }

    const points = topic.points
      .filter((point) => point.normalised !== currentMessage)
      .slice(-6);
    if (points.length) {
      lines.push('Confirmed points from the user (settled; do not ask again):');
      for (const point of points) lines.push(`- ${point.text}`);
    }

    const corrections = topic.corrections
      .filter((item) => item.normalised !== currentMessage)
      .slice(-3);
    if (corrections.length) {
      lines.push('User corrections (must follow):');
      for (const correction of corrections) lines.push(`- ${correction.text}`);
    }

    const products = [...topic.products.values()].slice(-6);
    if (products.length) {
      lines.push('Known products from this conversation:');
      for (const product of products) lines.push(`- ${productLine(product)}`);
    }
    const categories = [...topic.categories.values()].slice(-6);
    if (categories.length) {
      lines.push('Known categories from this conversation:');
      for (const category of categories) {
        lines.push(`- ${category.name}${category.id ? ` | id ${category.id}` : ''}`);
      }
    }
    if (topic.plans.length) {
      lines.push('Plan previews from this conversation:');
      for (const plan of topic.plans.slice(-4)) {
        const steps = plan.steps
          .map((step) => `${step.label}${step.name ? ` ${step.name}` : ''}`)
          .join('; ');
        lines.push(`- ${plan.id} | ${plan.status} | ${steps}`);
      }
    }
    const answered = topic.clarifications
      .filter((item) => item.status === 'answered')
      .slice(-3);
    if (answered.length) {
      lines.push('Already answered (do not ask again):');
      for (const item of answered) lines.push(`- ${settledAnswer(item)}`);
    }

    const earlier = conversation.topics
      .filter((candidate) => candidate.id !== topic.id)
      .sort((left, right) => right.lastAt - left.lastAt);
    if (earlier.length) {
      lines.push('Earlier topics in this session (use posnic_recall for details):');
      for (const item of earlier.slice(0, full ? 6 : 4)) {
        lines.push(`- ${item.title}: ${cleanText(item.summary, 180)}`);
      }
    }

    lines.push('This block is reference only, not a new instruction. The user\'s new message follows after it.');
    lines.push('[End conversation memory]');
    return truncateContext(lines.join('\n'), full ? MAX_CONTEXT_CHARS : MAX_SHORT_CONTEXT_CHARS);
  }

  function truncateContext(text, max) {
    if (text.length <= max) return text;
    const marker = '\n[End conversation memory]';
    const room = Math.max(0, max - marker.length - 3);
    return `${text.slice(0, room).trim()}...${marker}`;
  }

  function recall(conversationId, query, limit = 4) {
    const conversation = conversations.get(key(conversationId));
    const result = {
      kind: 'conversation_recall',
      query: cleanText(query, 200),
      topics: [],
    };
    if (!conversation) return result;
    const forms = tokenForms(query);
    const normalised = normalise(query);
    const max = Math.max(1, Math.min(Number(limit) || 4, 6));
    const scored = conversation.topics
      .map((topic) => ({ topic, score: scoreTopic(topic, forms, normalised) }))
      .filter((entry) => entry.score > 0 || !normalised)
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return right.topic.lastAt - left.topic.lastAt;
      })
      .slice(0, max);

    result.topics = scored.map(({ topic }) => ({
      id: topic.id,
      title: topic.title,
      status: topic.status,
      stage: topic.stage || 'idle',
      summary: topic.summary,
      points: topic.points.slice(-6).map((point) => point.text),
      corrections: topic.corrections.slice(-3).map((item) => item.text),
      products: [...topic.products.values()].slice(-6),
      categories: [...topic.categories.values()].slice(-6),
      plans: topic.plans.slice(-3),
      answered: topic.clarifications
        .filter((item) => item.status === 'answered')
        .slice(-3)
        .map((item) => ({ question: item.question, answer: item.answer })),
    }));
    return result;
  }

  function seed(conversationId, history) {
    const conversation = ensureConversation(conversationId);
    if (!conversation || conversation.topics.length) return false;
    for (const item of (Array.isArray(history) ? history : []).slice(-16)) {
      const role = item && item.role === 'assistant' ? 'assistant' : 'user';
      const content = cleanText(item && (item.content || item.text), 4000);
      if (!content) continue;
      if (role === 'user') beginTurn(conversationId, content);
      else completeTurn(conversationId, content, []);
    }
    return conversation.topics.length > 0;
  }

  function has(conversationId) {
    const conversation = conversations.get(key(conversationId));
    return !!(conversation && conversation.topics.length);
  }

  function clear(conversationId) {
    conversations.delete(key(conversationId));
  }

  function clearAll() {
    conversations.clear();
  }

  function currentCategory(conversationId) {
    const conversation = conversations.get(key(conversationId));
    const topic = activeTopic(conversation);
    if (!topic || !topic.currentCategory || !topic.currentCategory.name) return null;
    return {
      id: topic.currentCategory.id || '',
      name: topic.currentCategory.name,
    };
  }

  /* The rows a card may name: only those from that entity's latest search.
     A card is minted right after the search that informed it, so joining
     anything older would offer a label the operator is no longer looking at.
     Rows never stamped (an imported conversation) count as older than any
     search, and when no search has happened they are all there is. */
  function latestRows(map) {
    let latest = 0;
    for (const row of map.values()) {
      const seen = Number.isFinite(row.seenTurn) ? row.seenTurn : 0;
      if (seen > latest) latest = seen;
    }
    const rows = [];
    for (const row of map.values()) {
      if ((Number.isFinite(row.seenTurn) ? row.seenTurn : 0) === latest) rows.push(row);
    }
    return rows;
  }

  function recordFor(conversationId, name, slot) {
    const wanted = foldName(name);
    if (!wanted) return null;
    const conversation = conversations.get(key(conversationId));
    const topic = activeTopic(conversation);
    if (!topic) return null;
    /* The slot says which kind of record the choice can name, so an option
       can only ever resolve to the kind the question was about. A slot that
       does not say is not a guess to make: a label that happens to equal a
       product's name is a value, and the model can re-resolve it from words. */
    if (slot !== 'category' && slot !== 'target') return null;
    const rows = latestRows(slot === 'category' ? topic.categories : topic.products);
    const matches = rows.filter((row) => row.name && foldName(row.name) === wanted);
    const ids = new Set(matches.map((row) => row.id));
    /* Two rows that fold to one name are not a name at all: picking either
       one would put an id behind a button the operator reads as a single
       thing. Zero matches travels as words, which is the same refusal. */
    if (ids.size !== 1) return null;
    return { entity: slot === 'category' ? 'category' : 'product', id: matches[0].id };
  }

  /* Ids a tool returned this turn, recorded as soon as the tool answers.
     Memory only learns about a turn when it closes, but the model may target
     one of those ids in the same turn - refusing it as "unseen" would break
     the normal search-then-act flow. */
  function noteSeen(conversationId, rows) {
    const conversation = conversations.get(key(conversationId));
    if (!conversation) return;
    const topic = activeTopic(conversation);
    if (!topic) return;
    for (const row of Array.isArray(rows) ? rows : []) {
      const id = cleanText(row && row.id, 80);
      if (!id) continue;
      topic.seenIds.delete(id);
      topic.seenIds.set(id, cleanText(row && row.name, 160));
    }
    while (topic.seenIds.size > MAX_SEEN_IDS) {
      const oldest = topic.seenIds.keys().next().value;
      if (oldest === undefined) break;
      topic.seenIds.delete(oldest);
    }
  }

  /* The allow-list a plan target id is checked against: everything this
     topic's tools and searches actually showed. A plan may name a record by
     id only from here, so a model cannot point at a record nobody discussed;
     a name still resolves through the shop as before. */
  function knownIds(conversationId) {
    const conversation = conversations.get(key(conversationId));
    const topic = activeTopic(conversation);
    const ids = new Set();
    if (topic) {
      for (const id of topic.seenIds.keys()) ids.add(cleanText(id, 80).toLowerCase());
      for (const product of topic.products.values()) ids.add(cleanText(product.id, 80).toLowerCase());
      for (const category of topic.categories.values()) ids.add(cleanText(category.id, 80).toLowerCase());
    }
    /* Case-insensitive: an id is a hex string, and a pasted upper-case id is
       the same record the model will send back in lower case. */
    return { has: (value) => ids.has(cleanText(value, 80).toLowerCase()) };
  }

  function pendingRequest(conversationId) {
    const conversation = conversations.get(key(conversationId));
    const topic = activeTopic(conversation);
    if (!topic || !topic.pendingRequest) return null;    const waiting = [...topic.clarifications].reverse().find((item) => item.status === 'pending');
    return {
      text: topic.pendingRequest.text || '',
      note: topic.pendingRequest.note || '',
      asked: !!topic.pendingRequest.asked,
      draft: topic.pendingRequest.draft && typeof topic.pendingRequest.draft === 'object'
        ? JSON.parse(JSON.stringify(topic.pendingRequest.draft))
        : null,
      stage: topic.stage || 'idle',
      question: waiting ? waiting.question : '',
      missing: waiting && Array.isArray(waiting.missing) ? waiting.missing.slice() : [],
      answers: (Array.isArray(topic.pendingRequest.answers) ? topic.pendingRequest.answers : [])
        .slice(-6)
        /* Re-mapped here, so the decision has to be carried through or the
           prompt would render the raw wording again. */
        .map((item) => ({
          question: item.question,
          answer: item.answer,
          decision: item.decision || null,
        })),
      category: topic.currentCategory && topic.currentCategory.name
        ? {
            id: topic.currentCategory.id || '',
            name: topic.currentCategory.name,
          }
        : null,
    };
  }

  /* Only the user's own words. Known products are deliberately excluded so a
     previous product's price can never make a missing price look supplied. */
  function userTextFor(conversationId) {
    const conversation = conversations.get(key(conversationId));
    const topic = activeTopic(conversation);
    if (!topic) return '';
    const parts = topic.points.map((point) => point.text);
    for (const item of topic.clarifications) {
      if (item.answer) parts.push(item.answer);
    }
    return parts.join('\n');
  }

  function snapshot(conversationId) {
    const conversation = conversations.get(key(conversationId));
    if (!conversation) return null;
    return {
      id: conversation.id,
      activeTopicId: conversation.activeTopicId,
      topics: conversation.topics.map((topic) => ({
        id: topic.id,
        title: topic.title,
        status: topic.status,
        summary: topic.summary,
        keywords: topic.keywords.slice(),
        points: topic.points.map((point) => point.text),
        corrections: topic.corrections.map((item) => item.text),
        products: [...topic.products.values()],
        categories: [...topic.categories.values()],
        plans: topic.plans,
        clarifications: topic.clarifications,
        pendingRequest: topic.pendingRequest,
        currentCategory: topic.currentCategory,
        stage: topic.stage || 'idle',
      })),
    };
  }

  return {
    beginTurn,
    clear,
    clearAll,
    completeTurn,
    contextFor,
    currentCategory,
    has,
    knownIds,
    noteDraft,
    noteImage,
    notePlan,
    noteSeen,
    pendingRequest,
    recall,
    recordFor,
    seed,
    settledAnswer,
    snapshot,
    userTextFor,
  };
}

module.exports = {
  MAX_CONTEXT_CHARS,
  MAX_SHORT_CONTEXT_CHARS,
  MAX_SUMMARY_CHARS,
  createConversationMemoryStore,
};
