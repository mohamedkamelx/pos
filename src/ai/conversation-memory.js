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
  'على فكرة', 'شي ثاني', 'شيء آخر', 'سؤال مختلف',
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
  'لا تكمل', 'وقف', 'مش عايز', 'مش عاوز',
];

const NOT_IMPORTANT_RE = /^(مش مهم|مش مهمه|مش مهمة|لا يهم|مهمش|مش ضروري|مش ضرورى|whatever|doesn'?t matter|not important|skip)[!.?]*$/i;

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
  return hasPhrase(value, WRITE_ACTION_PHRASES) || hasPhrase(value, NEW_ENTITY_PHRASES);
}

function isCancellation(value) {
  return hasPhrase(value, CANCEL_PHRASES);
}

function isNotImportant(value) {
  return NOT_IMPORTANT_RE.test(normalise(value));
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
      plans: [],
      clarifications: [],
      pendingRequest: null,
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
    topic.categories.set(id, {
      id,
      name: cleanText(item.name, 160),
      description: cleanText(item.description, 240),
      itemCount: item.itemCount,
    });
    if (topic.categories.size > MAX_CATEGORIES) {
      const oldest = topic.categories.keys().next().value;
      if (oldest) topic.categories.delete(oldest);
    }
  }

  function addPlan(topic, plan) {
    if (!plan || !plan.id) return;
    const steps = (Array.isArray(plan.steps) ? plan.steps : []).map((step) => ({
      id: step.id,
      action: step.action,
      label: step.label,
      target: step.target,
      name: step.fields && step.fields.name,
      before: step.before && step.before.name,
      resultId: step.resultId,
      resultName: step.resultName,
    }));
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
      }
    }
  }

  function addClarification(topic, result) {
    if (!result || !result.question) return;
    for (const item of topic.clarifications) {
      if (item.status === 'pending') item.status = 'superseded';
    }
    const note = cleanText(result.pending, MAX_TEXT_CHARS);
    const missing = (Array.isArray(result.missing) ? result.missing : [])
      .map((item) => cleanText(item, 60))
      .filter(Boolean)
      .slice(0, 8);
    topic.clarifications.push({
      question: cleanText(result.question, 300),
      options: (Array.isArray(result.options) ? result.options : [])
        .slice(0, 4)
        .map((option) => cleanText(option && option.label, 80))
        .filter(Boolean),
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
      };
    }
    if (note) topic.pendingRequest.note = note;
    topic.pendingRequest.asked = true;
  }

  function markClarification(topic, message, status) {
    if (!topic) return;
    const pending = [...topic.clarifications].reverse().find((item) => item.status === 'pending');
    if (!pending) return;
    pending.status = status || 'answered';
    if (pending.status === 'answered') {
      pending.answer = cleanText(message, 200);
      pending.answeredAt = current();
    }
  }

  function ingestToolCalls(topic, toolCalls) {
    for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
      const result = call && call.metadata && call.metadata.posnic;
      if (!result) continue;
      if (result.kind === 'product_search' || result.kind === 'product_list') {
        for (const item of Array.isArray(result.results) ? result.results : []) addProduct(topic, item);
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
    if (topic.plans.length) {
      parts.push(`Plans: ${topic.plans.slice(-3).map((plan) => `${plan.id} ${plan.status}`).join(', ')}`);
    }
    const answered = topic.clarifications.filter((item) => item.status === 'answered').slice(-3);
    if (answered.length) {
      parts.push(`Answered: ${answered.map((item) => `${item.question} -> ${item.answer}`).join('; ')}`);
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

  function beginTurn(conversationId, text) {
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
    const newEntity = hasPhrase(message, NEW_ENTITY_PHRASES);
    const cancellation = isCancellation(message);
    const wasPending = !!(previous && previous.pendingRequest);
    /* The first create/update request also creates a pending draft. Only a
       short follow-up while that draft already existed is an answer; the
       original request itself must still be allowed to search first. */
    const pendingAnswer = wasPending && !newSignal && !newEntity && !cancellation &&
      (!looksLikeWriteRequest(message) || forms.size <= 3);

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
      !actionFollowUp && !pendingAnswer) {
      topic = best.topic;
      switched = true;
      resumed = true;
      reason = 'related';
    } else if (newEntity) {
      topic = createTopic(conversation, message);
      switched = true;
      reason = 'new';
    } else if (actionFollowUp || pendingAnswer) {
      reason = 'follow-up';
    } else if (!continuation && !actionFollowUp && activeScore <= 0 && forms.size >= 2 &&
      !GREETING_RE.test(normalised)) {
      topic = createTopic(conversation, message);
      switched = true;
      reason = 'new';
    }

    if (previous && switched && previous !== topic) {
      previous.status = 'archived';
      markClarification(previous, '', 'abandoned');
    }
    if (!topic) topic = createTopic(conversation, message);
    topic.status = 'active';
    topic.lastAt = current();
    topic.updatedAt = current();
    conversation.activeTopicId = topic.id;
    conversation.updatedAt = current();

    if (cancellation) {
      topic.pendingRequest = null;
      for (const item of topic.clarifications) {
        if (item.status === 'pending') item.status = 'cancelled';
      }
    } else if (looksLikeWriteRequest(message) &&
      (!topic.pendingRequest || newEntity || !pendingAnswer)) {
      topic.pendingRequest = {
        text: cleanText(message, MAX_TEXT_CHARS),
        at: current(),
        note: '',
        asked: false,
      };
    }

    markClarification(topic, message, 'answered');
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
      writeRequest: looksLikeWriteRequest(message),
      pendingAnswer: pendingAnswer && !switched,
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
    return { topicId: topic.id, title: topic.title };
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
    addPoint(topic, `Plan ${plan.id} ${status || plan.status || 'updated'}`);
    updateSummary(topic);
    conversation.updatedAt = current();
    return { topicId: topic.id, title: topic.title };
  }

  function contextFor(conversationId, { full = false, message = '' } = {}) {
    const conversation = conversations.get(key(conversationId));
    const topic = activeTopic(conversation);
    if (!conversation || !topic) return '';
    const currentMessage = normalise(message);
    const lines = ['[Conversation memory]'];
    lines.push(`Active topic: ${topic.title}`);
    if (topic.summary) lines.push(`Summary: ${topic.summary}`);

    if (topic.pendingRequest && (topic.pendingRequest.text || topic.pendingRequest.note)) {
      const resumed = !!(topic.pendingRequest.asked || topic.pendingRequest.note);
      lines.push(resumed
        ? 'Unfinished request (continue it; do not search or start over):'
        : 'Request in progress (search first for a duplicate, then continue):');
      if (topic.pendingRequest.text) lines.push(`- Request: ${topic.pendingRequest.text}`);
      if (topic.pendingRequest.note) lines.push(`- Draft: ${topic.pendingRequest.note}`);
      const waiting = [...topic.clarifications].reverse().find((item) => item.status === 'pending');
      if (waiting) lines.push(`- Waiting for the answer to: ${waiting.question}`);
      if (resumed) {
        lines.push('A short answer, including "مش مهم", answers this request. It is not a reason to search or change topic.');
      }
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
      for (const item of answered) lines.push(`- ${item.question} -> ${item.answer}`);
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

  function pendingRequest(conversationId) {
    const conversation = conversations.get(key(conversationId));
    const topic = activeTopic(conversation);
    if (!topic || !topic.pendingRequest) return null;
    const waiting = [...topic.clarifications].reverse().find((item) => item.status === 'pending');
    return {
      text: topic.pendingRequest.text || '',
      note: topic.pendingRequest.note || '',
      asked: !!topic.pendingRequest.asked,
      question: waiting ? waiting.question : '',
      missing: waiting && Array.isArray(waiting.missing) ? waiting.missing.slice() : [],
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
      })),
    };
  }

  return {
    beginTurn,
    clear,
    clearAll,
    completeTurn,
    contextFor,
    has,
    notePlan,
    pendingRequest,
    recall,
    seed,
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
