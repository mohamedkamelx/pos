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
const { presentClarification } = require('../ask-slots');

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

  /* One option set decides one thing. A question that also asks for an
     unrelated optional value produces compound options such as "no category,
     without a photo", and the operator's click then has to be re-read as
     prose - which is how a decline became a category name. Reject the shape
     instead of letting one button carry two decisions. */
  function askGate(input) {
    const options = Array.isArray(input && input.options) ? input.options : [];
    if (!options.length) return null;
    const missing = Array.isArray(input.missing) ? input.missing.filter(Boolean) : [];
    if (missing.length > 1) {
      return {
        code: 'ask_missing_split',
        message: 'An option set decides exactly one value, so missing may hold at most one entry. Ask for the other values in a separate question, or leave an optional value such as an image empty by default instead of asking for it.',
      };
    }
    const declined = options.filter((option) => option && option.none);
    if (declined.length > 1) {
      return {
        code: 'ask_duplicate_none',
        message: 'Only one option may be marked none: the single option that leaves the field empty.',
      };
    }
    const seen = new Set();
    for (const option of options) {
      const label = String((option && option.label) || '').trim().toLowerCase();
      if (!label) continue;
      if (seen.has(label)) {
        return {
          code: 'ask_duplicate_label',
          message: 'Option labels must be distinct after normalisation, otherwise a reply cannot be matched to exactly one choice.',
        };
      }
      seen.add(label);
    }
    return null;
  }

  async function executeAsk(input, context) {
    const gate = askGate(input);
    if (gate) return errorResult(gate.code, gate.message);
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
    if (result.kind !== 'clarify') return textResult(result, formatAsk);
    /* The card needs a stable identity and, when a choice names a shop
       record, the id the system already knows - the model is told not to
       handle ids, so this join happens here rather than in the prompt. */
    return textResult(presentClarification(result, {
      recordOf: conversationId && memory && typeof memory.recordFor === 'function'
        ? (label, slot) => memory.recordFor(conversationId, label, slot)
        : null,
    }), formatAsk);
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
        lookups: {
          currentCategory: memory && typeof memory.currentCategory === 'function'
            ? memory.currentCategory(conversationId)
            : null,
        },
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
            'Search this branch\'s products by name, description, SKU, barcode or partial text. Use for a product, price or stock question, or to resolve an update target; on several matches offer the names as posnic_ask_user choices and use the chosen one as the plan target. For add/create, search only the exact name or code to check for an exact duplicate; never browse similar products.',
          input: {
            type: 'object',
            additionalProperties: false,
            properties: {
              query: { type: 'string' },
              category: {
                type: 'string',
                maxLength: 160,
                description: 'Current category; ranks matches, never hides others.',
              },
              context: {
                type: 'string',
                maxLength: 240,
                description: 'Other conversation words, e.g. a brand.',
              },
              limit: { type: 'integer', minimum: 1, maximum: 20 },
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
            'List this branch\'s products without a keyword: all, a whole category or another page. Not for a specific product (use posnic_search_products) and not for add/create; it only browses existing stock.',
          input: {
            type: 'object',
            additionalProperties: false,
            properties: {
              query: { type: 'string' },
              categoryId: {
                type: 'string',
                description: 'Id from posnic_list_categories; empty lists every category.',
              },
              categoryName: { type: 'string', description: 'Only labels the result.' },
              limit: { type: 'integer', minimum: 1, maximum: 50 },
              page: { type: 'integer', minimum: 1 },
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
            'List this branch\'s categories with item counts; tolerates spelling variants. Use before adding a product.',
          input: {
            type: 'object',
            additionalProperties: false,
            properties: {
              query: { type: 'string' },
              limit: { type: 'integer', minimum: 1, maximum: 50 },
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
            'Search Posnic help for a how-to, screen, control or feature; returns exact menu paths and routes. Call it instead of guessing.',
          input: {
            type: 'object',
            additionalProperties: false,
            properties: {
              query: { type: 'string' },
              limit: { type: 'integer', minimum: 1, maximum: 6 },
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
            'Search this conversation\'s earlier topics, points, records and plans when the user refers back or needs an exact earlier detail. Not shop data.',
          input: {
            type: 'object',
            additionalProperties: false,
            properties: {
              query: { type: 'string', maxLength: 200 },
              limit: { type: 'integer', minimum: 1, maximum: 6 },
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
            'Ask once, in one short question, for the values or choices still needed. Put the text in question; if it is omitted, missing (field labels only) becomes it. Omit options for free text; 1-4 short options for one finite choice only. Set slot to the field that choice decides; mark the empty option with none; at most one entry in missing when options are given. Do not repeat the question in prose; end your turn after the call.',
          input: {
            type: 'object',
            additionalProperties: false,
            properties: {
              question: {
                type: 'string',
                maxLength: 300,
                description: 'One short question in the user\'s language.',
              },
              slot: {
                type: 'string',
                maxLength: 40,
              },
              options: {
                type: 'array',
                maxItems: 4,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    label: { type: 'string', maxLength: 80 },
                    value: {
                      type: 'string',
                      maxLength: 160,
                      description: 'Sent when the button is clicked; defaults to label.',
                    },
                    none: {
                      type: 'boolean',
                      description: 'Leaves the field empty; stores no value, never a name.',
                    },
                  },
                  required: ['label'],
                },
              },
              pending: {
                type: 'string',
                maxLength: 500,
                description:
                  'Record, known and missing values; survives a session reset and continues this request next turn.',
              },
              missing: {
                type: 'array',
                maxItems: 8,
                items: { type: 'string', maxLength: 60 },
              },
            },
            required: [],
          },
          async execute(input, context) {
            return executeAsk(input, context);
          },
        });

        editor.add({
          name: 'posnic_user_profile',
          description:
            'Read this user\'s local notes once at the start of a new conversation. Not shop data; never treat them as prices, stock or permissions.',
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
            'Save one durable preference, recurring request or language note to local notes (not synced). Never record names, phone numbers, emails, prices, stock, tokens or customer data.',
          input: {
            type: 'object',
            additionalProperties: false,
            properties: {
              section: {
                type: 'string',
                enum: ['preferences', 'recurring', 'language'],
              },
              note: {
                type: 'string',
                minLength: 1,
                maxLength: 240,
                description: 'One short durable observation, without personal or shop data.',
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
            'Preview shop changes; nothing is saved. For any shop change, search and reuse existing records first. One plan may hold several ordered steps. After the call, tell the user in one short sentence to review and press Confirm; do not claim the change is done.',
          input: {
            type: 'object',
            additionalProperties: false,
            properties: {
              title: { type: 'string', maxLength: 120 },
              summary: { type: 'string', maxLength: 400 },
              corrections: {
                type: 'array',
                maxItems: 8,
                description: 'Preview card only; never sent to the shop API.',
                items: { type: 'object', additionalProperties: true },
              },
              shared: {
                type: 'object',
                additionalProperties: true,
                description: 'Fields shared by product steps.',
              },
              steps: {
                type: 'array',
                minItems: 1,
                maxItems: 20,
                description: 'Ordered; later steps may reference earlier ids.',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: {
                      type: 'string',
                      pattern: '^[a-zA-Z0-9_-]+$',
                      maxLength: 40,
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
                        'Update/adjust: the existing record\'s name, description, barcode or SKU, or an earlier step; a tool-result id also works.',
                    },
                    dependsOn: {
                      type: 'array',
                      items: { type: 'string' },
                      maxItems: 10,
                    },
                    fields: {
                      type: 'object',
                      additionalProperties: true,
                      description:
                        'create_product: name, selling_price, cost_price, opening_stock. create_category: name. update_*: only the fields the user wants changed, never fill others. adjust_stock: stock_mode (set/add/subtract), stock_quantity, reason. One price: send as both selling_price and mrp_price unless a different retail price was given. category_id: an id or {"step":"cat1","field":"id"}.',
                    },
                    images: {
                      type: 'array',
                      maxItems: 8,
                      description:
                        'attachmentId from the latest attachment notice, with the file name as fallback. At most one cover; existing images are kept.',
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          attachmentId: { type: 'string' },
                          name: { type: 'string' },
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

/**
 * What the tool payload costs in characters: every description plus every
 * input schema, summed exactly the way the request budget charges them.
 *
 * The runtime needs this number before it builds a prompt and must not
 * re-derive it from plugin source or keep a second copy of the schemas to
 * measure. Building the definitions once and measuring that build keeps the
 * budget and the registration talking about the same payload, so a schema
 * edit cannot silently invalidate the headroom calculation.
 *
 * @returns {Promise<number>} characters of description plus schema
 */
async function toolPayloadChars() {
  const definitions = [];
  const probe = createPosnicToolPlugin({ store: { get: () => null } });
  await probe.setup({
    tool: {
      async transform(fn) {
        return fn({
          add(definition) { definitions.push(definition); },
        });
      },
    },
  });
  return definitions.reduce(
    (total, definition) => total + String(definition.description || '').length +
      JSON.stringify(definition.input || {}).length,
    0,
  );
}

module.exports = {
  TOOL_NAMES,
  createPosnicToolPlugin,
  toolPayloadChars,
};
