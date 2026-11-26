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
    const result = askUser(input, {
      pendingText: pending && pending.text,
      pendingNote: pending && pending.note,
      answered: pending && pending.answers,
      currentCategory: pending && pending.category,
    });
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
    return [
      'A change preview is now visible to the user. Nothing has been saved.',
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
            'Search this branch by product name, SKU, barcode or partial text. Use it for a specific product, price or stock question. Returns up to 20 matches.',
          input: {
            type: 'object',
            additionalProperties: false,
            properties: {
              query: {
                type: 'string',
                description: 'The product name, barcode, SKU or partial words the user gave.',
              },
              category: {
                type: 'string',
                maxLength: 160,
                description:
                  'Optional category the conversation is currently working in. It ranks matching products; it never hides a product outside the category.',
              },
              context: {
                type: 'string',
                maxLength: 240,
                description:
                  'Optional other words from the current conversation, such as a brand or the category just created.',
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
            'List this branch\'s products without a keyword. Use for all products, a whole category or another page. Do not use it for a specific product; use posnic_search_products.',
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
            'List this branch\'s categories with item counts. Use before adding a product. If no category matches, ask once whether to create a suitable named category or leave it uncategorized. Tolerates spelling variants. Returns up to 50.',
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
            'Search Posnic help for a how-to, screen, control or feature. Returns exact menu paths and routes. Call it instead of guessing.',
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
            'Search this conversation\'s earlier topics, points, records and plans. Use when the user refers back or you need an exact earlier detail. Do not use for shop data.',
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
            'Ask once, in one short question, for every missing required value plus the optional product image and category choice together. For a new product with no matching category, the category part must offer exactly: create a named category (suggest one from the product type) or leave it uncategorized. Omit options when the answer needs free text; use 1-4 short options only for one finite choice. Do not repeat the question in prose; end your turn after the call.',
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
                  'Compact note naming the record, known values and missing values. It survives a session reset and continues the same request next turn.',
              },
              missing: {
                type: 'array',
                maxItems: 8,
                items: { type: 'string', maxLength: 60 },
                description: 'Required values still missing, for example "selling price".',
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
            'Read this user\'s local notes once at the start of a new conversation. They are not shop data; never treat them as prices, stock or permissions.',
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
            'Save one durable preference or recurring request to local notes. Never record names, phone numbers, emails, prices, stock, tokens or customer data. Not synced.',
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
            'Prepare a preview of shop changes; nothing is saved. Use for create/update product or category, or adjust stock. Search and reuse existing records first. A new product needs name, selling price, cost price and opening stock; ask once for missing values, the optional image and whether to create a named category or leave it uncategorized. Never choose an unrelated category. Images need attachment ids. After the call, tell the user in one short sentence to review and press Confirm; do not claim the change is done.',
          input: {
            type: 'object',
            additionalProperties: false,
            properties: {
              title: {
                type: 'string',
                maxLength: 120,
                description: 'Short title.',
              },
              summary: {
                type: 'string',
                maxLength: 400,
                description: 'One-sentence summary.',
              },
              shared: {
                type: 'object',
                additionalProperties: true,
                description: 'Optional fields shared by product steps.',
              },
              steps: {
                type: 'array',
                minItems: 1,
                maxItems: 20,
                description: 'Ordered steps; later steps may reference earlier ids.',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: {
                      type: 'string',
                      pattern: '^[a-zA-Z0-9_-]+$',
                      maxLength: 40,
                      description: 'Short id for references.',
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
                      description: 'Change type.',
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
                        'Existing id, exact name, barcode or SKU for update/adjust; may reference an earlier step.',
                    },
                    dependsOn: {
                      type: 'array',
                      items: { type: 'string' },
                      maxItems: 10,
                      description: 'Earlier step ids that must finish first.',
                    },
                    fields: {
                      type: 'object',
                      additionalProperties: true,
                      description:
                        'Action fields. create_product needs name, selling_price, cost_price, opening_stock; create_category needs name; update_* may include name, prices, stock or category; adjust_stock uses stock_mode (set/add/subtract), stock_quantity, reason. Send one price as both selling_price and mrp_price unless a different retail price was given. category_id may be an id or {"step":"cat1","field":"id"}.',
                    },
                    images: {
                      type: 'array',
                      maxItems: 8,
                      description: 'Attachment ids; cover at most one. Existing images are kept.',
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
