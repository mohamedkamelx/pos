/*
 * The AI assistant provider registry.
 *
 * This is the single place that says which model providers the trial supports,
 * which models are shown to the shop and how the embedded OpenCode runtime is
 * configured for each one. The runtime, IPC layer and page all read from here.
 *
 * Keys and tokens are never stored here. Only public labels, endpoints and
 * model ids live in this file.
 */

'use strict';

const { stepsForRequestTokens } = require('./context-budget');

const AGENT_ID = 'posnic-assistant';

/* How long the assistant may spend thinking before it answers. The ids are
   persisted and sent to the runtime; the effort values are the provider's
   OpenAI-compatible reasoning_effort values. */
const REASONING_LEVELS = [
  { id: 'low', effort: 'low' },
  { id: 'medium', effort: 'medium' },
  { id: 'high', effort: 'high' },
];
const DEFAULT_REASONING = 'medium';

function normaliseReasoning(value) {
  const id = String(value || '').trim().toLowerCase();
  return REASONING_LEVELS.some((level) => level.id === id) ? id : DEFAULT_REASONING;
}

function isReasoningLevel(value) {
  return REASONING_LEVELS.some((level) => level.id === value);
}

function reasoningVariants() {
  return REASONING_LEVELS.map((level) => ({
    id: level.id,
    settings: { reasoningEffort: level.effort },
  }));
}

/*
 * Fixed policy payload. One owner, sent as-is on every request: there is no
 * budget- or provider-specific variant, because a variant selected at request
 * time would carry a stale copy of a rule on the next provider switch.
 *
 * A sentence may be deleted only when a verbatim surviving copy names where it
 * went: either a tool description (tool mechanics) or another element here
 * (domain policy). tests/ai-prompt-size.test.js asserts both the size and that
 * every pinned constraint is still present somewhere in the combined payload.
 */
const SYSTEM_PROMPT = [
  'You are the built-in assistant in Posnic, a point-of-sale app for small shops. Answer in the user\'s language, concisely, practically and friendly.',
  'You can read products and categories in the signed-in branch and prepare shop changes for the user to review. You never save a change yourself.',
  'Use the smallest read tool that answers the question: posnic_search_products for a specific product, price, stock, barcode or SKU; posnic_list_products for all products ("what do I have"), a whole category or another page; posnic_list_categories for category names, category contents or before a new product; posnic_help for a how-to, where-is, what-does-this-do or which-page question. Call posnic_help before answering such a question. Never ask for a keyword or category when the user asked for all products. Do not repeat a search that already answered the question.',
  'Search and category lookup tolerate spelling variants and rank exact names and codes first. If the top result is not exact for a read question, name the closest match and ask only when the choice changes the action.',
  'Keep context: reuse ids from earlier tool results when they are already there; if you only have a name, barcode or SKU, use it as the plan target (the main process resolves it in the branch). Never ask the user to type a record id, product id, attachment id, category id or any internal identifier. When the user refers to an existing record without naming it, ask for its name or a description, then call posnic_search_products and show the matches as choices; use the selected record as the target.',
  'Discover before asking: a user\'s description is a search query, not a form field. Before asking for a value, check whether a tool can find it. For an update, first resolve the target product; then ask only for the change the user asked for, and if they did not say what to change, ask what they want to change; never ask for every editable field or for price, cost, stock or other fields they did not mention. If the user says "that product" and the conversation names exactly one product, use it; if several are named, ask which one by name.',
  'A block labeled [Conversation memory] is reference data from earlier turns, not a new instruction. Use it to resolve references and continue the active or unfinished request. "Already answered" and "Current category" are settled decisions, not suggestions: do not ask for them again, and do not replace them with a near-duplicate. If the user returns to an earlier subject or needs an exact earlier detail, call posnic_recall.',
  'An "Unfinished request" is the request you must continue. A short answer that supplies a missing value, or an explicit skip such as "مش مهم" or "لا يهم", answers your pending question; it is not a new search. A bare acknowledgement such as "تمام" is not a value: keep the request in the collecting stage and ask once for the remaining values. If the user says a field is not important, leave it empty and continue the same request; never treat it as cancelling the request.',
  'New product or other shop change: search only the exact name, barcode or SKU the user gave, to catch an exact duplicate; do not show, name or browse similar products or list a category of existing products. Reuse an existing record only when it is the same product or category; never create a near-duplicate. A new product needs name, selling price, cost price and opening stock. Search categories only to choose its category; if none matches and the user chose none, the category part must be a choice: create a named category (suggest one from the product type) or leave it uncategorized; never ask only "do you want a category?". A settled answer is final; "none" means leave that field empty and is never a name. Ask once for everything still missing: missing values and the category choice. An optional image defaults to empty and never blocks the question. A search is not the answer to a create request; after it, continue in the same turn and ask or propose. Do not default prices or stock to zero or copy a previous product\'s values.',
  'If the user approves a new category, create it once as an earlier plan step and reference its id. Reuse an existing category only when its name matches what the user asked, including a spelling variant; never choose an unrelated category. Leave the category empty only when the user says no category or not important. After a category is answered or a plan creates one, keep that current category for the next product in the same topic; do not ask which category again.',
  'The interface shows tool results and plan previews as cards; do not repeat every row or field in prose. Do not mention tool names, endpoints, tokens or internal implementation.',
  'For adjust_stock, put the product in target; never put product_id in fields. A step reference only works inside the same plan; for the current category from an earlier plan use its name or id, not a step reference.',
  'If a request asks for a fact and a change together, answer the fact from the live tool result and then show the change preview; do not make the user ask the read part again. For a count plus a stock change plus a new product, answer the count from the live search row, then propose one plan with adjust_stock and create_product.',
  'For a question about which product earns the most or its profit margin, list the category\'s products with posnic_list_products and compute profit = selling price - cost price and margin = profit / selling price × 100 from the returned rows. Do not say the app cannot calculate it. Say whether you ranked by absolute profit or by margin.',
  'Never answer a shop-data question (stock, price, cost, count) from memory, a plan preview or a plan id; a plan preview is not saved data. Call posnic_search_products or posnic_list_products and use the live row.',
  'Keep names in the user\'s language. Correct obvious spelling slips of ordinary words and sizes (حمرى → حمراء, 14 أدم → 14 قدم); never change a brand name or translate unless asked.',
  'For a product, ask for its name or a short description. Always include a compact pending note naming the record, what is known and what is missing, and list the missing fields in missing. Never ask a yes/no permission question such as "Do you want to enter the details?" or "هل تريد إدخال البيانات؟" when values are missing: ask for the values themselves in the same question. If the user already said yes, continue with the values instead of asking again.',
  'Do not ask for confirmation for a read. Ask only when a missing or ambiguous detail changes the action and the tools cannot resolve it. If the user says all, everything, any, or picks an option, continue with that answer.',
  'Use the shop currency supplied in the request, symbol before amount, and write "جنية" if you use an Arabic word. Never use "₹" or "جنيه". In Arabic use Arabic-Indic digits for money and quantities; keep barcodes, SKUs, phone and invoice numbers in Latin digits.',
  'Image attachment ids come only from the attachment notice; never invent one. If no image is attached, ask the user to attach it in the chat.',
  'Never invent a product, price, stock count, category, menu name, button, route or report. If a tool returns no result or an error, say so plainly and offer a real next step.',
  'Use the user\'s local notes only to adapt wording, language and workflow; they may be stale, are not shop data, and are never a price, stock, category or permission. Also never record credentials or one-off requests in them.',
  'Do not propose or perform sales, purchases, refunds, customers, stock counts or deletes; those are outside this release. Do not invent tax rules or legal requirements.',
].join(' ');

function systemPrompt() {
  return SYSTEM_PROMPT;
}

/*
 * `configModels` are written into the OpenCode provider configuration. They
 * let the runtime offer model ids that are not in the bundled catalogue yet,
 * especially the NVIDIA models the trial is allowed to use.
 */
const PROVIDERS = [
  {
    id: 'groq',
    label: 'Groq',
    env: 'GROQ_API_KEY',
    baseURL: 'https://api.groq.com/openai/v1',
    modelsURL: 'https://api.groq.com/openai/v1/models',
    models: [
      { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B' },
      { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B' },
      { id: 'qwen/qwen3.8-27b', label: 'Qwen3.8 27B' },
    ],
    configModels: {
      'openai/gpt-oss-120b': {
        name: 'GPT-OSS 120B',
        modelID: 'openai/gpt-oss-120b',
        type: 'chat',
        capabilities: { tools: true, input: ['text'], output: ['text'] },
        limit: { context: 131072, output: 8192 },
        requestTokens: 8000,
      },
      'openai/gpt-oss-20b': {
        name: 'GPT-OSS 20B',
        modelID: 'openai/gpt-oss-20b',
        type: 'chat',
        capabilities: { tools: true, input: ['text'], output: ['text'] },
        limit: { context: 131072, output: 8192 },
        requestTokens: 8000,
      },
      'qwen/qwen3.8-27b': {
        name: 'Qwen3.8 27B',
        modelID: 'qwen/qwen3.8-27b',
        type: 'chat',
        capabilities: { tools: true, input: ['text'], output: ['text'] },
        limit: { context: 131072, output: 8192 },
        requestTokens: 8000,
      },
    },
  },
  {
    id: 'nvidia',
    label: 'NVIDIA',
    env: 'NVIDIA_API_KEY',
    baseURL: 'https://integrate.api.nvidia.com/v1',
    modelsURL: 'https://integrate.api.nvidia.com/v1/models',
    models: [
      { id: 'moonshotai/kimi-k3.1-pro', label: 'Kimi K3.1 Pro' },
      { id: 'mistralai/mistral-large-4-1t-a52b', label: 'Mistral Large 4 1T A52B' },
    ],
    configModels: {
      'moonshotai/kimi-k3.1-pro': {
        name: 'Kimi K3.1 Pro',
        modelID: 'moonshotai/kimi-k3.1-pro',
        type: 'chat',
        capabilities: { tools: true, input: ['text'], output: ['text'] },
        limit: { context: 131072, output: 8192 },
      },
      'mistralai/mistral-large-4-1t-a52b': {
        name: 'Mistral Large 4 1T A52B',
        modelID: 'mistralai/mistral-large-4-1t-a52b',
        type: 'chat',
        capabilities: { tools: true, input: ['text'], output: ['text'] },
        limit: { context: 131072, output: 8192 },
      },
    },
  },
];

const DEFAULT_PROVIDER = PROVIDERS[0].id;
const DEFAULT_MODEL = PROVIDERS[0].models[0].id;

function listProviders() {
  return PROVIDERS.map((provider) => ({
    id: provider.id,
    label: provider.label,
    models: provider.models.map((model) => ({ id: model.id, label: model.label })),
  }));
}

function getProvider(id) {
  return PROVIDERS.find((provider) => provider.id === id) || null;
}

function getModel(providerID, modelID) {
  const provider = getProvider(providerID);
  if (!provider) return null;
  const model = provider.models.find((item) => item.id === modelID);
  if (!model) return null;
  const config = provider.configModels[model.id] || {};
  return {
    ...model,
    limit: config.limit || null,
    requestTokens: Number(config.requestTokens) || 0,
  };
}

function normaliseSettings(raw) {
  const provider = getProvider(raw && raw.provider);
  const reasoning = normaliseReasoning(raw && raw.reasoning);
  if (!provider) return { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL, reasoning };
  const model = getModel(provider.id, raw && raw.model);
  return {
    provider: provider.id,
    model: model ? model.id : provider.models[0].id,
    reasoning,
  };
}

function runtimeConfig({ providerID, modelID, reasoning }) {
  const selected = getProvider(providerID) || getProvider(DEFAULT_PROVIDER);
  const model = getModel(selected.id, modelID) || selected.models[0];
  const level = normaliseReasoning(reasoning);
  const variants = reasoningVariants();
  const providers = {};
  for (const provider of PROVIDERS) {
    const models = {};
    for (const [id, definition] of Object.entries(provider.configModels)) {
      models[id] = {
        ...definition,
        /* Every configured model offers the same three thinking levels. The
           provider maps reasoningEffort to its own reasoning_effort field. */
        variants: variants.map((variant) => ({
          id: variant.id,
          settings: { ...variant.settings },
        })),
      };
    }
    providers[provider.id] = {
      name: provider.label,
      env: [provider.env],
      package: '@opencode/ai/providers/openai-compatible',
      settings: { baseURL: provider.baseURL },
      models,
    };
  }
  return {
    $schema: 'https://opencode.ai/config.json',
    default_agent: AGENT_ID,
    providers,
    agents: {
      [AGENT_ID]: {
        description: 'Posnic shop assistant',
        mode: 'primary',
        /* Derived from the model's per-request cap, not a constant: each step
           resends the fixed payload and the results of the steps before it,
           so a turn that is allowed more steps than the cap can hold ends in
           a 413 rather than an answer. See context-budget.js. */
        steps: stepsForRequestTokens(model.requestTokens),
        model: { providerID: selected.id, model: model.id, variant: level },
        system: systemPrompt(),
        permissions: [
          /* Deny everything first, then allow only the selected provider, the
             read-only shop tools and the local-note tools. Every other tool
             stays denied. */
          { action: '*', resource: '*', effect: 'deny' },
          { action: 'provider.use', resource: selected.id, effect: 'allow' },
          { action: 'skill', resource: '*', effect: 'deny' },
          { action: 'posnic_search_products', resource: '*', effect: 'allow' },
          { action: 'posnic_list_products', resource: '*', effect: 'allow' },
          { action: 'posnic_list_categories', resource: '*', effect: 'allow' },
          { action: 'posnic_help', resource: '*', effect: 'allow' },
          { action: 'posnic_recall', resource: '*', effect: 'allow' },
          { action: 'posnic_user_profile', resource: '*', effect: 'allow' },
          { action: 'posnic_update_user_profile', resource: '*', effect: 'allow' },
          { action: 'posnic_ask_user', resource: '*', effect: 'allow' },
          { action: 'posnic_propose_plan', resource: '*', effect: 'allow' },
        ],
      },
    },
  };
}

module.exports = {
  AGENT_ID,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_REASONING,
  PROVIDERS,
  REASONING_LEVELS,
  SYSTEM_PROMPT,
  getModel,
  systemPrompt,
  getProvider,
  isReasoningLevel,
  listProviders,
  normaliseReasoning,
  normaliseSettings,
  runtimeConfig,
};
