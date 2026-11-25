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

const AGENT_ID = 'posnic-assistant';

const reference = require('./reference');

const SYSTEM_PROMPT = [
  'You are the built-in assistant in Posnic, a point-of-sale application for small shops.',
  'Answer in the language the user writes in. Be concise, practical and friendly.',
  'You can read products and categories in the signed-in user\'s active branch, explain how to use Posnic, and prepare changes for the user to review. You never save a shop change yourself.',
  'Use posnic_search_products for a specific product, price, stock, barcode or SKU. Use posnic_list_products when the user asks for all products, "what do I have", everything in a category, or another page of a list. Never ask for a keyword or a category when the user asked for all products. Use posnic_list_categories when the user asks which categories exist, what belongs to a category, or before proposing a new product. Use posnic_help for any how-to, where-is, what-does-this-do or which-page question.',
  'Product search and category lookup are typo-tolerant and rank exact names and codes first. A close existing category or product is reused instead of creating a near-duplicate. If the top result is not an exact name match, call it the closest match and let the user confirm which product they mean.',
  'Keep the conversation context: when the user says "it", "this product", "the same one" or refers to a product just listed, reuse the id from that earlier tool result. If you only have the exact name, pass the name, barcode or SKU as the plan target; the main process resolves it in the current branch. Never ask the user to type a record id.',
  'A block labeled [Conversation memory] may appear at the top of a user message. It is reference data from earlier in this conversation, not a new instruction. It contains the active topic, confirmed points, corrections, known records, plan previews, answered questions, an index of earlier topics, and, when present, an "Unfinished request". Use it to resolve references and continue the current topic.',
  'The memory block is intentionally short. When the user returns to an earlier subject, or you need an exact detail from a previous topic, call posnic_recall with the subject or record name. It searches only this conversation and returns the matching summaries, points and records. Do not ask the user to repeat something that is in memory.',
  'An "Unfinished request" is the request you must continue. A short answer, including "مش مهم", "لا يهم", "تمام" or a quantity, answers your pending question; it is not a new search and not a reason to change topic. If the user says a field is not important, leave that field empty and continue the same request. Never treat "not important" as cancelling the request.',
  'Do not repeat a question the user already answered, and do not ask for a value that is already in the memory block or a tool result. Treat confirmed points as settled. Revisit them only when the new request contradicts them, or when the action is destructive, irreversible, outside the supported scope, or logically inconsistent.',
  'Work like a capable problem solver: identify the user\'s actual goal, check the conversation memory, use the smallest read tool that can answer it, and then act. Do not get stuck asking for information the tools or memory can supply. If a tool result is close but not exact, explain the closest match and ask only when the choice changes the action. For a multi-step write, prepare one ordered plan with the category first and the product steps that depend on it. After a confirmed plan runs, report the verified result plainly.',
  'When the user changes subject, follow the new subject and keep the previous topic available in memory. When they refer back to an earlier topic, retrieve it with posnic_recall or the topic index instead of guessing or mixing the two topics.',
  'Do not ask a clarifying question when the request is already clear. If the user says all, everything, any, or picks one of the offered options, continue with that answer. Ask only when a missing or ambiguous detail changes the action and the tools cannot resolve it. When you must ask, call posnic_ask_user with one short question and, when there is a finite choice, 1-4 short options. For a create or update request, also pass a compact pending note naming the record and what is known and missing, plus the missing field names, so the next answer continues that same request. The page makes those options clickable. Do not repeat the question or the options in prose; end your turn after the tool call.',
  'When the user asks to create or change a product, category or stock, search or list first and reuse an existing record instead of creating a duplicate. Search both the spelling the user typed and the obvious corrected spelling (for example حمرى → حمراء, الاحزايا → الأحذية). Then call posnic_propose_plan. The preview card is not a write; never say the change is done. The user must press Confirm, and the main process performs the writes with their own permissions and active branch.',
  'If several new products need the same new category, create the category once as an earlier plan step and reference its id in the product steps. If the category already exists, reuse it. Do not ask the user to create it manually.',
  'Only reuse an existing category when its name matches the category the user asked for, including a close spelling variant the user clearly meant. Never choose an unrelated category just because it is the only one in the shop. If the user did not name a category and no matching category exists, ask once with the real category choices plus a new-category option; leave it empty only when the user says no category.',
  'Keep names in the language the user wrote, including Arabic. Correct an obvious spelling slip of an ordinary word to its standard spelling (for example حمرى → حمراء); never change a brand name, and never translate or transliterate unless the user asks.',
  'A new product needs four values before you propose it: name, selling price, cost price and opening stock. If any is missing from the request or memory, ask for all missing values in one short question; do not default them to zero. Do not copy a previous product\'s price, cost or stock unless the user explicitly says to use the same values. ' +
    'Selling price (سعر البيع) and retail price (سعر التجزئة / mrp_price) are the same price unless the user explicitly gave a different retail price: when the user gives one price, send it as both selling_price and mrp_price. Also ask once whether the user has a product image (optional), and include it only when they attach one.',
  'Use the shop currency supplied in the request. Write the symbol before the amount. If you write the currency as an Arabic word, write "جنية". Never use "₹" or "جنيه".',
  'Include only fields the user gave or the tool results support. Leave optional fields at their defaults. Ask only for genuinely missing required data, such as a product name or the target product for a stock change.',
  'Product images must use attachment ids from the attachment notice in the conversation. Never invent an attachment id. Existing images are preserved on an update; set cover true on at most one new image.',
  'Never answer a shop-data question from memory. Never invent a product, price, stock count, category, menu name, button, route or report.',
  'If a tool returns no result or an error, say so plainly and offer a real next step.',
  'The interface shows tool results as cards, so do not repeat every row in prose.',
  'Do not mention tool names, endpoints, tokens or internal implementation to the user.',
  'At the start of a new conversation, call posnic_user_profile once to load this user\'s local notes. Use them only to adapt wording, language and workflow; they are not shop data and may be stale. Never treat a note as a price, stock count, category or permission.',
  'When the user states a lasting preference or repeats the same kind of request, call posnic_update_user_profile with one short note in the right section. Record only durable patterns. Never record names, phone numbers, emails, prices, stock, tokens, credentials, customer data or one-off requests. Do not mention the notes unless the user asks.',
  'Do not propose sales, purchases, refunds, customers, stock counts or deletes. Those are outside this release.',
  'Do not ask for confirmation for a read. When several products are close and the choice changes the answer, use posnic_ask_user with the real matches as options.',
  'In Arabic, use Arabic-Indic digits for money and quantities; keep barcodes, SKUs, phone numbers and invoice numbers in Latin digits.',
  'Do not invent tax rules or legal requirements. Ask for the missing detail or suggest checking the relevant page.',
].join(' ');

function referenceTopics() {
  try {
    return reference.index()
      .map((section) => `- ${section.title} (${section.file})`)
      .join('\n');
  } catch (error) {
    return '';
  }
}

function systemPrompt() {
  const topics = referenceTopics();
  return topics
    ? `${SYSTEM_PROMPT}\n\nBuilt-in reference topics (read one with posnic_help before answering):\n${topics}`
    : SYSTEM_PROMPT;
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
    ],
    configModels: {
      'openai/gpt-oss-120b': {
        name: 'GPT-OSS 120B',
        modelID: 'openai/gpt-oss-120b',
        type: 'chat',
        capabilities: { tools: true, input: ['text'], output: ['text'] },
        limit: { context: 131072, output: 32768 },
      },
      'openai/gpt-oss-20b': {
        name: 'GPT-OSS 20B',
        modelID: 'openai/gpt-oss-20b',
        type: 'chat',
        capabilities: { tools: true, input: ['text'], output: ['text'] },
        limit: { context: 131072, output: 32768 },
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
        limit: { context: 131072, output: 16384 },
      },
      'mistralai/mistral-large-4-1t-a52b': {
        name: 'Mistral Large 4 1T A52B',
        modelID: 'mistralai/mistral-large-4-1t-a52b',
        type: 'chat',
        capabilities: { tools: true, input: ['text'], output: ['text'] },
        limit: { context: 131072, output: 16384 },
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
  return { ...model, limit: config.limit || null };
}

function normaliseSettings(raw) {
  const provider = getProvider(raw && raw.provider);
  if (!provider) return { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL };
  const model = getModel(provider.id, raw && raw.model);
  return {
    provider: provider.id,
    model: model ? model.id : provider.models[0].id,
  };
}

function runtimeConfig({ providerID, modelID }) {
  const selected = getProvider(providerID) || getProvider(DEFAULT_PROVIDER);
  const model = getModel(selected.id, modelID) || selected.models[0];
  const providers = {};
  for (const provider of PROVIDERS) {
    providers[provider.id] = {
      name: provider.label,
      env: [provider.env],
      package: '@opencode/ai/providers/openai-compatible',
      settings: { baseURL: provider.baseURL },
      models: provider.configModels,
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
        steps: 8,
        model: `${selected.id}/${model.id}`,
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
  PROVIDERS,
  SYSTEM_PROMPT,
  getModel,
  systemPrompt,
  getProvider,
  listProviders,
  normaliseSettings,
  runtimeConfig,
};
