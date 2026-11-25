/*
 * The assistant's read-only tool plugin.
 *
 * The model only sees tools that this plugin registers. Each tool borrows the
 * signed-in user's JWT and active branch from the session context and calls
 * the local API, so branch scope and ACL checks are the same as the rest of
 * Posnic. Write tools are intentionally absent: the model can propose a plan
 * only in a later milestone, and the main process executes confirmed plans.
 */

'use strict';

const { createApiClient } = require('./api-client');
const { formatForModel: formatProducts, searchProducts } = require('./search-products');
const { formatForModel: formatProductList, listProducts } = require('./list-products');
const { formatForModel: formatCategories, listCategories } = require('./list-categories');
const { formatForModel: formatHelp, searchHelp } = require('./help');
const { askUser, formatForModel: formatAsk } = require('./ask-user');
const { recallConversation, formatForModel: formatRecall } = require('./recall');
const { validatePlan } = require('../actions/plan-schema');

const TOOL_NAMES = [
  'posnic_search_products',
  'posnic_list_products',
  'posnic_list_categories',
  'posnic_help',
  'posnic_recall',
  'posnic_user_profile',
  'posnic_update_user_profile',
  'posnic_ask_user',
  'posnic_propose_plan',
];

const SECTION_LABELS = {
  preferences: 'Preferences',
  recurring: 'Recurring requests',
  language: 'Language and wording',
};

function textResult(result, formatter) {
  return {
    content: [{ type: 'text', text: formatter(result) }],
    metadata: { posnic: result },
  };
}

function errorResult(code, message) {
  return textResult({ kind: 'error', code, message }, (result) =>
    `The Posnic tool failed: ${result.message} (code: ${result.code}).`);
}

function sessionContext(store, context) {
  const sessionID = context && context.sessionID;
  const session = store.get(sessionID);
  if (!session) {
    return null;
  }
  if (!session.token) {
    return null;
  }
  return session;
}

function createPosnicToolPlugin({
  store,
  profileStore,
  planStore,
  attachments,
  memory,
  fetchImpl,
  logger,
} = {}) {
  if (!store || typeof store.get !== 'function') {
    throw new Error('The Posnic tool plugin needs a context store.');
  }
  const log = typeof logger === 'function' ? logger : () => {};

  function apiFor(context) {
    const session = sessionContext(store, context);
    if (!session) {
      return { error: errorResult('auth_required', 'Sign in again to use shop data.') };
    }
    try {
      return {
        api: createApiClient({
          baseUrl: session.apiBaseUrl,
          token: session.token,
          branchId: session.branchId,
          fetchImpl,
        }),
      };
    } catch (error) {
      return { error: errorResult(error.code || 'configuration_error', error.message) };
    }
  }

  async function executeSearch(input, context) {
    const ready = apiFor(context);
    if (ready.error) return ready.error;
    const result = await searchProducts(input, { api: ready.api });
    if (result.kind === 'error') {
      log(`[AI tool] product search failed: ${result.code}`);
    }
    return textResult(result, formatProducts);
  }

  async function executeProductList(input, context) {
    const ready = apiFor(context);
    if (ready.error) return ready.error;
    const result = await listProducts(input, { api: ready.api });
    if (result.kind === 'error') {
      log(`[AI tool] product list failed: ${result.code}`);
    }
    return textResult(result, formatProductList);
  }

  async function executeCategories(input, context) {
    const ready = apiFor(context);
    if (ready.error) return ready.error;
    const result = await listCategories(input, { api: ready.api });
    if (result.kind === 'error') {
      log(`[AI tool] category list failed: ${result.code}`);
    }
    return textResult(result, formatCategories);
  }

  async function executeHelp(input) {
    const result = searchHelp(input);
    return textResult(result, formatHelp);
  }

  async function executeAsk(input, context) {
    const session = sessionContext(store, context);
    const conversationId = session && (session.conversationId || session.sessionID);
    const pending = conversationId && memory && typeof memory.pendingRequest === 'function'
      ? memory.pendingRequest(conversationId)
      : null;
    const result = askUser(input, { pendingText: pending && pending.text });
    return textResult(result, formatAsk);
  }

  function executeRecall(input, context) {
    const session = sessionContext(store, context);
    const conversationId = session && (session.conversationId || session.sessionID);
    const result = recallConversation(input, {
      memory,
      conversationId,
    });
    return textResult(result, formatRecall);
  }

  function formatPlan(result) {
    if (result.kind === 'error') {
      return `The change could not be prepared: ${result.message} (code: ${result.code}).`;
    }
    const plan = result.plan;
    const lines = plan.steps.map((step, index) => {
      const name = step.fields && step.fields.name ? `: ${step.fields.name}` : '';
      const before = step.before && step.before.name ? ` (currently ${step.before.name})` : '';
      return `${index + 1}. ${step.label}${name}${before}`;
    });
    return [
      'A change preview is now visible to the user. Nothing has been saved.',
      ...lines,
      ...(plan.warnings.length ? ['Review notes:', ...plan.warnings.map((warning) => `- ${warning}`)] : []),
      'Tell the user in one short sentence to review the preview and press Confirm. Do not say the change is done, and do not repeat every field.',
    ].join('\n');
  }

  async function executeProposal(input, context) {
    const ready = apiFor(context);
    if (ready.error) return ready.error;
    if (!planStore || typeof planStore.add !== 'function') {
      return errorResult('plan_unavailable', 'Change previews are not available on this computer.');
    }
    const session = sessionContext(store, context);
    const conversationId = session && (session.conversationId || session.sessionID);
    let result;
    try {
      result = await validatePlan(input, {
        api: ready.api,
        sessionID: conversationId,
        attachments,
        userText: memory && typeof memory.userTextFor === 'function'
          ? memory.userTextFor(conversationId)
          : '',
      });
    } catch (error) {
      return errorResult(error.code || 'plan_failed', error.message || 'The change could not be prepared.');
    }
    if (!result.ok) {
      log(`[AI tool] plan rejected: ${result.code}`);
      return errorResult(result.code, result.message);
    }
    result.plan.conversationId = conversationId;
    planStore.add(result.plan);
    return textResult({ kind: 'write_plan', plan: result.plan }, formatPlan);
  }

  function profileFor(context) {
    const session = sessionContext(store, context);
    if (!session) {
      return { error: errorResult('auth_required', 'Sign in again to use local notes.') };
    }
    if (!session.username) {
      return { error: errorResult('auth_required', 'Sign in again to use local notes.') };
    }
    if (!profileStore || typeof profileStore.forUser !== 'function') {
      return { error: errorResult('profile_unavailable', 'Local notes are not available on this computer.') };
    }
    return { profile: profileStore.forUser(session.username) };
  }

  function formatProfile(result) {
    if (!result.exists) {
      return 'No local notes have been saved for this user yet.';
    }
    return [
      'Local notes for this user. They are not shop data.',
      'Use them only to adapt wording and workflow. Never treat a note as a price, stock count, category or permission.',
      '',
      result.text,
    ].join('\n');
  }

  async function executeProfile(input, context) {
    const ready = profileFor(context);
    if (ready.error) return ready.error;
    const result = ready.profile.read();
    return textResult({
      kind: 'user_profile',
      exists: result.exists,
      counts: result.counts,
      text: result.text,
    }, formatProfile);
  }

  async function executeUpdateProfile(input, context) {
    const ready = profileFor(context);
    if (ready.error) return ready.error;
    const result = ready.profile.append(input);
    if (!result.ok) {
      log(`[AI tool] profile note rejected: ${result.code}`);
      return errorResult(result.code, result.message);
    }
    return textResult({
      kind: 'profile_saved',
      section: result.section,
      note: result.note,
      added: result.added,
      duplicate: result.duplicate,
      counts: result.counts,
    }, (saved) => {
      if (saved.duplicate) return 'That note is already in the user\'s local notes.';
      return `Saved to the user's local notes under ${SECTION_LABELS[saved.section] || saved.section}.`;
    });
  }

  return {
    id: 'posnic-shop-tools',
    async setup(ctx) {
      const registration = await ctx.tool.transform((editor) => {
        editor.add({
          name: 'posnic_search_products',
          description:
            'Search this shop\'s products in the signed-in branch by name, SKU, barcode or partial text. ' +
            'Use this before answering any question about a product, its price, its stock or whether it exists. ' +
            'Returns up to 20 matches. Do not use it for sales, purchases, customers or reports.',
          input: {
            type: 'object',
            additionalProperties: false,
            properties: {
              query: {
                type: 'string',
                description: 'The product name, barcode, SKU or partial words the user gave.',
              },
              limit: {
                type: 'integer',
                minimum: 1,
                maximum: 20,
                description: 'Maximum number of matches to return. Defaults to 8.',
              },
            },
            required: ['query'],
          },
          async execute(input, context) {
            return executeSearch(input, context);
          },
        });

        editor.add({
          name: 'posnic_list_products',
          description:
            'List the current branch\'s products without requiring a keyword. Use this when the user asks for all products, "what do I have", everything in a category, or the next page of a list. ' +
            'Do not ask the user to choose a category when they asked for all products. Do not use it for a specific product question; use posnic_search_products for that.',
          input: {
            type: 'object',
            additionalProperties: false,
            properties: {
              query: {
                type: 'string',
                description: 'Optional words to filter by. Leave empty to list every product in the branch.',
              },
              categoryId: {
                type: 'string',
                description: 'Optional category id from posnic_list_categories. Leave empty for every category.',
              },
              categoryName: {
                type: 'string',
                description: 'Optional category name, used only to label the result.',
              },
              limit: {
                type: 'integer',
                minimum: 1,
                maximum: 50,
                description: 'Maximum number of products to return. Defaults to 20.',
              },
              page: {
                type: 'integer',
                minimum: 1,
                description: 'Page number for a long list. Defaults to 1.',
              },
            },
            required: [],
          },
          async execute(input, context) {
            return executeProductList(input, context);
          },
        });

        editor.add({
          name: 'posnic_list_categories',
          description:
            'List this shop\'s categories in the signed-in branch, with how many items each contains. ' +
            'Use this when the user asks which categories exist, what belongs to a category, or before proposing a new product. ' +
            'The lookup tolerates Arabic and Latin spelling variants, so a close existing name is a match. ' +
            'Returns up to 50 categories. Do not use it for sales, purchases, customers or reports.',
          input: {
            type: 'object',
            additionalProperties: false,
            properties: {
              query: {
                type: 'string',
                description:
                  'Optional words from a category name. Leave empty to list every category in the branch.',
              },
              limit: {
                type: 'integer',
                minimum: 1,
                maximum: 50,
                description: 'Maximum number of categories to return. Defaults to 20.',
              },
            },
            required: [],
          },
          async execute(input, context) {
            return executeCategories(input, context);
          },
        });

        editor.add({
          name: 'posnic_help',
          description:
            'Search Posnic\'s built-in reference for how to use a screen, where a control is, or what a feature does. ' +
            'Use this for any "how do I", "where is", "what does this do" or "which page" question. ' +
            'Returns exact menu paths, control labels and routes. Never guess a screen name without calling it.',
          input: {
            type: 'object',
            additionalProperties: false,
            properties: {
              query: {
                type: 'string',
                description: 'The task, screen or feature the user is asking about.',
              },
              limit: {
                type: 'integer',
                minimum: 1,
                maximum: 6,
                description: 'Maximum number of reference sections to return. Defaults to 3.',
              },
            },
            required: ['query'],
          },
          async execute(input) {
            return executeHelp(input);
          },
        });

        editor.add({
          name: 'posnic_recall',
          description:
            'Search this conversation\'s earlier topics and confirmed details. Use it when the user refers to something from earlier, when you need an exact product/category/plan detail from a previous topic, or when you are unsure whether a point was already settled. ' +
            'It returns topic summaries, confirmed points, corrections, records and plan previews without loading the whole conversation. Do not use it for shop data you can read with the product or category tools.',
          input: {
            type: 'object',
            additionalProperties: false,
            properties: {
              query: {
                type: 'string',
                maxLength: 200,
                description: 'The subject, product name, category, decision or detail to find.',
              },
              limit: {
                type: 'integer',
                minimum: 1,
                maximum: 6,
                description: 'Maximum number of matching topics to return. Defaults to 4.',
              },
            },
            required: ['query'],
          },
          async execute(input, context) {
            return executeRecall(input, context);
          },
        });

        editor.add({
          name: 'posnic_ask_user',
          description:
            'Ask the user one short clarification question and, when there is a finite choice, give 1-4 short clickable options. ' +
            'Use this only when a missing or ambiguous detail changes the action and the read tools cannot resolve it. ' +
            'Do not use it when the request is already clear. For example, if the user asks for all products, list them instead of asking which category. ' +
            'When the question is about an unfinished create or update request, pass a pending note and the missing field names so the next answer continues that same request. ' +
            'Ask once for all missing required values, not one value at a time. ' +
            'After calling it, do not repeat the question or the options in your reply; the page shows them and the user can click one.',
          input: {
            type: 'object',
            additionalProperties: false,
            properties: {
              question: {
                type: 'string',
                maxLength: 300,
                description: 'One short question in the user\'s language.',
              },
              options: {
                type: 'array',
                maxItems: 4,
                description: 'Optional short choices. Omit for a free-text answer such as a product name.',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    label: {
                      type: 'string',
                      maxLength: 80,
                      description: 'The short text shown on the button.',
                    },
                    value: {
                      type: 'string',
                      maxLength: 160,
                      description: 'The message sent when the button is clicked. Defaults to the label.',
                    },
                  },
                  required: ['label'],
                },
              },
              pending: {
                type: 'string',
                maxLength: 500,
                description:
                  'For a create/update request, a compact note naming the product or category, the values already given, and what is still missing. Example: "Create product حزمة زرقاء in category احذية; given: quantity 1; missing: selling price, cost price, description (user said not important)." This note survives a session reset and is shown to you on the next turn.',
              },
              missing: {
                type: 'array',
                maxItems: 8,
                items: { type: 'string', maxLength: 60 },
                description: 'Names of the required values still missing, such as "selling price", "cost price" or "opening stock".',
              },
            },
            required: ['question'],
          },
          async execute(input, context) {
            return executeAsk(input, context);
          },
        });

        editor.add({
          name: 'posnic_user_profile',
          description:
            'Read this user\'s local notes about how they like to work and what they ask for repeatedly. ' +
            'Call it once at the start of a new conversation. The notes are not shop data: never treat them as prices, stock, categories or permissions.',
          input: {
            type: 'object',
            additionalProperties: false,
            properties: {},
            required: [],
          },
          async execute(input, context) {
            return executeProfile(input, context);
          },
        });

        editor.add({
          name: 'posnic_update_user_profile',
          description:
            'Save one short, durable note about this user\'s preferences, recurring requests or wording in their local notes on this computer. ' +
            'Use it only when the user states a lasting preference or repeats the same kind of request. ' +
            'Never record names, phone numbers, emails, prices, stock, tokens, credentials, customer data or one-off requests. This is not a shop record and is never synced.',
          input: {
            type: 'object',
            additionalProperties: false,
            properties: {
              section: {
                type: 'string',
                enum: ['preferences', 'recurring', 'language'],
                description: 'Which local notes section the observation belongs to.',
              },
              note: {
                type: 'string',
                minLength: 1,
                maxLength: 240,
                description: 'One short, durable observation without personal or shop data.',
              },
            },
            required: ['section', 'note'],
          },
          async execute(input, context) {
            return executeUpdateProfile(input, context);
          },
        });

        editor.add({
          name: 'posnic_propose_plan',
          description:
            'Prepare a preview of shop changes for the user to review. This does NOT save anything. The page shows a preview card with Confirm and Cancel, and the main process performs the writes only after the user confirms. ' +
            'Use it for: create or update a product, create or update a category, or adjust stock. Never use it for sales, purchases, refunds, customers, stock counts or deletes. ' +
            'Always search first and reuse an existing product or category instead of creating a duplicate, including a close spelling variant. If several new products need the same new category, create the category once as an earlier step and reference its id in the product steps. ' +
            'A new product needs name, selling price, cost price and opening stock. If any is missing, ask for all missing values in one short question with posnic_ask_user; do not default them to zero. ' +
            'Selling price and retail price (mrp_price) are the same price unless the user explicitly gave a different retail price: when the user gives one price, set both to that value. ' +
            'Ask once whether the user has an optional product image before proposing. ' +
            'Include only fields the user actually gave or that the tool results support. Leave optional fields at their defaults. Ask a short question with posnic_ask_user only when a required detail is genuinely missing. ' +
            'Images must use attachment ids from the attachment notice; never invent an id. After calling this tool, tell the user in one short sentence to review the preview and press Confirm, and do not claim the change is done.',
          input: {
            type: 'object',
            additionalProperties: false,
            properties: {
              title: {
                type: 'string',
                maxLength: 120,
                description: 'A short title such as "Add three drinks".',
              },
              summary: {
                type: 'string',
                maxLength: 400,
                description: 'One sentence describing the whole change.',
              },
              shared: {
                type: 'object',
                additionalProperties: true,
                description:
                  'Optional product fields applied to every product step when that step does not set them, for example {"inventory":true,"unit":"qty"}.',
              },
              steps: {
                type: 'array',
                minItems: 1,
                maxItems: 20,
                description: 'Ordered steps. A later step can reference an earlier step by id.',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: {
                      type: 'string',
                      pattern: '^[a-zA-Z0-9_-]+$',
                      maxLength: 40,
                      description: 'Short id used by later steps, for example "cat1" or "p1".',
                    },
                    action: {
                      type: 'string',
                      enum: [
                        'create_category',
                        'update_category',
                        'create_product',
                        'update_product',
                        'adjust_stock',
                      ],
                      description: 'The kind of change.',
                    },
                    target: {
                      anyOf: [
                        { type: 'string' },
                        {
                          type: 'object',
                          additionalProperties: false,
                          properties: {
                            step: { type: 'string' },
                            field: { type: 'string', enum: ['id', 'name'] },
                          },
                          required: ['step'],
                        },
                      ],
                      description:
                        'For update_product, update_category and adjust_stock: the existing record id from a search result, or the exact product/category name, barcode or SKU. The main process resolves the name in the current branch. Can reference an earlier step.',
                    },
                    dependsOn: {
                      type: 'array',
                      items: { type: 'string' },
                      maxItems: 10,
                      description: 'Optional earlier step ids that must finish first.',
                    },
                    fields: {
                      type: 'object',
                      additionalProperties: true,
                      description:
                        'Action fields. create_category: name, description. update_category: name, description, is_active. create_product: name, selling_price, cost_price and opening_stock are required (ask for any missing value; zero is allowed only when the user gave zero), plus mrp_price, inventory, negative_stock, item_kind, category_id, category_name, barcode, sku, description, unit. update_product: the same fields except opening_stock. adjust_stock: stock_mode (set/add/subtract), stock_quantity, reason, note. ' +
                        'Selling price and retail price (mrp_price) must be equal unless the user explicitly gave a different retail price; when only one price is given, send it as both selling_price and mrp_price. ' +
                        'A category_id may be a real id or a reference such as {"step":"cat1","field":"id"}.',
                    },
                    images: {
                      type: 'array',
                      maxItems: 8,
                      description:
                        'Product images from the attachment notice. Set cover true on at most one image. Existing images are preserved on update.',
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          attachmentId: { type: 'string' },
                          cover: { type: 'boolean' },
                        },
                        required: ['attachmentId'],
                      },
                    },
                  },
                  required: ['id', 'action', 'fields'],
                },
              },
            },
            required: ['title', 'steps'],
          },
          async execute(input, context) {
            return executeProposal(input, context);
          },
        });
      });

      return () => registration.dispose();
    },
  };
}

module.exports = {
  TOOL_NAMES,
  createPosnicToolPlugin,
};
