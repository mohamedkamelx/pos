/*
 * Pending write plans.
 *
 * A plan is proposed by the model, shown to the user, and only then executed
 * by the main process. Plans live in memory for a short time. They contain no
 * token and are never written to disk or synced.
 */

'use strict';

const DEFAULT_TTL_MS = 15 * 60 * 1000;

/* Tool metadata can be frozen by the runtime. Plans are mutable state in the
   store and executor, so copy the whole plan, including its step objects. */
function clonePlan(plan) {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(plan);
    } catch (error) {
      /* Fall through to the JSON copy for plain data. */
    }
  }
  return JSON.parse(JSON.stringify(plan));
}

function createPlanStore({ ttlMs = DEFAULT_TTL_MS, now = Date.now } = {}) {
  const plans = new Map();
  const lifetime = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS;

  function get(id) {
    const key = String(id || '');
    const plan = plans.get(key);
    if (!plan) {
      return { ok: false, code: 'plan_not_found', message: 'That change is no longer available. Ask me to prepare it again.' };
    }
    if (plan.expiresAt && plan.expiresAt < now()) {
      plans.delete(key);
      return { ok: false, code: 'plan_expired', message: 'That change expired. Ask me to prepare it again.' };
    }
    return { ok: true, plan };
  }

  function add(plan) {
    const next = {
      ...clonePlan(plan),
      createdAt: plan.createdAt || now(),
      expiresAt: plan.expiresAt || (now() + lifetime),
    };
    plans.set(next.id, next);
    return next;
  }

  function begin(id) {
    const found = get(id);
    if (!found.ok) return found;
    const plan = found.plan;
    if (plan.status === 'running') {
      return { ok: false, code: 'plan_running', message: 'That change is already running.' };
    }
    if (plan.status === 'cancelled') {
      return { ok: false, code: 'plan_cancelled', message: 'That change was cancelled. Ask me to prepare it again.' };
    }
    if (plan.status === 'completed') {
      return { ok: true, plan, already: true };
    }
    plan.status = 'running';
    plan.runningAt = now();
    plan.confirmCount = (plan.confirmCount || 0) + 1;
    return { ok: true, plan };
  }

  function finish(id, status) {
    const found = get(id);
    if (!found.ok) return found;
    found.plan.status = status;
    found.plan.finishedAt = now();
    return found;
  }

  function cancel(id) {
    const found = get(id);
    if (!found.ok) return found;
    if (found.plan.status === 'running') {
      return { ok: false, code: 'plan_running', message: 'That change is already running and cannot be cancelled.' };
    }
    found.plan.status = 'cancelled';
    found.plan.cancelledAt = now();
    plans.delete(id);
    return { ok: true };
  }

  function remove(id) {
    plans.delete(String(id || ''));
  }

  function clearConversation(conversationId) {
    const key = String(conversationId || '');
    if (!key) return;
    for (const [id, plan] of plans.entries()) {
      if (plan.conversationId === key) plans.delete(id);
    }
  }

  function clearAll() {
    plans.clear();
  }

  return { add, begin, cancel, clearAll, clearConversation, finish, get, remove };
}

module.exports = { DEFAULT_TTL_MS, createPlanStore };
