/*
 * Executes a confirmed write plan through the local API.
 *
 * The model never calls this module directly. The renderer confirms a plan,
 * the main process borrows the signed-in user's JWT and active branch, and
 * every step goes through the same routes the normal pages use. Successful
 * steps are read back before the plan is reported as complete.
 */

'use strict';

const MAX_IMAGES = 8;

function cleanText(value, max) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > max ? text.slice(0, max) : text;
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function idOf(payload) {
  const data = payload && payload.data;
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return '';
  return String((data && (data.id || data._id)) || '');
}

function dataOf(payload) {
  return payload && payload.data ? payload.data : null;
}

function listOf(payload) {
  const data = payload && payload.data;
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.list)) return data.list;
  return [];
}

function isRef(value) {
  return !!value && typeof value === 'object' && typeof value.step === 'string';
}

function resolveValue(value, results) {
  if (!isRef(value)) return value;
  const result = results.get(value.step);
  if (!result) throw new Error('An earlier step did not finish, so this change cannot run.');
  const field = value.field || 'id';
  const resolved = result[field];
  if (!resolved) throw new Error(`The earlier step did not return a ${field}.`);
  return resolved;
}

function resolveFields(fields, results) {
  const out = {};
  for (const [key, value] of Object.entries(fields || {})) {
    out[key] = resolveValue(value, results);
  }
  return out;
}

function resolveTarget(target, results) {
  return isRef(target) ? resolveValue(target, results) : target;
}

async function fetchItem(api, id) {
  const payload = await api.get('items/' + encodeURIComponent(id));
  return dataOf(payload);
}

async function fetchCategory(api, id) {
  const payload = await api.get('categories/' + encodeURIComponent(id));
  return dataOf(payload);
}

function normaliseName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[\u064B-\u0652\u0670\u0640]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function sameText(left, right) {
  return normaliseName(left) === normaliseName(right);
}

function sameNumber(left, right) {
  return Math.abs(number(left) - number(right)) < 0.005;
}

/* The plan named its target by the name the record carried when the operator
   approved it. If the live record no longer carries that name it was renamed
   after the preview: refuse rather than write to a record the operator never
   saw. A step with no recorded name (an older plan, a target that is a
   reference to an earlier step in this same plan) has nothing to check. */
function assertSameTarget(step, name) {
  const expected = cleanText(step && step.targetName, 200);
  if (!expected) return;
  const actual = cleanText(name, 200);
  if (actual && !sameText(actual, expected)) {
    throw new Error('This record changed since the preview was made. Review the change again.');
  }
}

function imageRows(images) {
  return (Array.isArray(images) ? images : []).map((image) => ({
    name: cleanText(image && image.name, 300),
    size: parseInt(image && image.size, 10) || 0,
    cover: image && image.cover === 'yes' ? 'yes' : 'no',
  })).filter((image) => image.name);
}

function existingImageRows(current) {
  const rows = imageRows(current && current.multi_image);
  if (rows.length) return rows;
  const single = cleanText(current && current.image, 300);
  if (!single || single === 'item.svg') return [];
  return [{ name: single, size: 0, cover: 'yes' }];
}

function mergeImages(current, uploaded, requestedCover) {
  const existing = imageRows(current);
  const next = existing.concat(imageRows(uploaded));
  const seen = new Set();
  const unique = [];
  for (const image of next) {
    if (seen.has(image.name)) continue;
    seen.add(image.name);
    unique.push(image);
  }
  const wanted = cleanText(requestedCover, 300);
  let cover = '';
  if (wanted && unique.some((image) => image.name === wanted)) cover = wanted;
  if (!cover) {
    const flagged = unique.find((image) => image.cover === 'yes');
    if (flagged) cover = flagged.name;
  }
  if (!cover && unique.length) cover = unique[0].name;
  return unique.map((image) => ({
    ...image,
    cover: image.name === cover ? 'yes' : 'no',
  }));
}

async function uploadImages(api, attachments, sessionID, requested) {
  if (!Array.isArray(requested) || !requested.length) return [];
  if (requested.length > MAX_IMAGES) throw new Error(`Attach up to ${MAX_IMAGES} images to a product.`);
  const described = attachments && typeof attachments.describe === 'function'
    ? attachments.describe(sessionID, requested.map((image) => image.attachmentId))
    : null;
  if (!described || !described.ok) {
    throw new Error((described && described.message) || 'An attached image is no longer available.');
  }
  const coverIndex = requested.findIndex((image) => image.cover === true);
  const payload = described.attachments.map((attachment, index) => ({
    name: attachment.name,
    size: attachment.size,
    cover: index === (coverIndex >= 0 ? coverIndex : 0) ? 'yes' : 'no',
    data: attachment.data,
  }));
  const result = await api.post('items/uploadItemMultiImage', { items_image: payload });
  const uploaded = listOf(result);
  if (!uploaded.length) throw new Error('The images could not be uploaded.');
  return uploaded;
}

function productPayload(fields, images, cover) {
  return {
    name: fields.name,
    selling_price: fields.selling_price,
    company_price: fields.cost_price,
    mrp_price: fields.mrp_price !== undefined ? fields.mrp_price : fields.selling_price,
    available_quantity: fields.opening_stock,
    inventory: fields.inventory,
    negative_stock: fields.negative_stock,
    item_kind: fields.item_kind,
    category_id: fields.category_id || '',
    category_name: fields.category_name || '',
    barcode_id: fields.barcode || '',
    sku_id: fields.sku || '',
    description: fields.description || '',
    unit: fields.unit || 'qty',
    ...(images.length ? { image: images, cover_image: cover } : {}),
  };
}

function currentProductPayload(current, fields, images, cover) {
  const payload = {
    name: fields.name !== undefined ? fields.name : cleanText(current.name, 200),
    selling_price: fields.selling_price !== undefined ? fields.selling_price : number(current.selling_price),
    company_price: fields.cost_price !== undefined ? fields.cost_price : number(current.company_price),
    mrp_price: fields.mrp_price !== undefined
      ? fields.mrp_price
      : (fields.selling_price !== undefined ? fields.selling_price : number(current.mrp_price)),
    supplier_name: cleanText(current.supplier_name, 200),
    supplier_id: current.supplier_id || '',
    category_id: fields.category_id !== undefined ? fields.category_id : (current.category_id || ''),
    category_name: fields.category_name !== undefined ? fields.category_name : cleanText(current.category_name, 200),
    discount_amount: number(current.discount_amount),
    discount_percentage: number(current.discount_percentage),
    description: fields.description !== undefined ? fields.description : cleanText(current.description, 1000),
    unit: fields.unit !== undefined ? fields.unit : (cleanText(current.unit, 40) || 'qty'),
    unit_id: current.unit_id || '',
    inventory: fields.inventory !== undefined ? fields.inventory : current.track_inventory === true,
    negative_stock: fields.negative_stock !== undefined ? fields.negative_stock : current.negative_stock === true,
    item_kind: fields.item_kind !== undefined ? fields.item_kind : (current.item_kind === 'service' ? 'service' : 'product'),
    barcode_id: fields.barcode !== undefined ? fields.barcode : cleanText(current.barcode_id, 120),
    sku_id: fields.sku !== undefined ? fields.sku : cleanText(current.sku || current.itemid, 120),
    image: images,
    cover_image: cover,
    position: parseInt(current.sort_order, 10) || 0,
  };
  for (const key of [
    'item_weight_machine_based',
    'items_mfg_date',
    'items_expiry_date',
    'open_price',
    'tile_color',
    'tile_shape',
    'brand',
    'tags',
    'reorder_point',
    'parcel_details',
    'service_unit',
  ]) {
    if (current[key] !== undefined) payload[key] = current[key];
  }
  return payload;
}

function expectedStock(before, fields) {
  /* `available_quantity` is the live row's field and `stock` is what
     beforeProduct() carries out of the preview. Prefer the live one so the
     answer is the same number the read-back will report. */
  const current = before && before.available_quantity !== undefined
    ? before.available_quantity
    : (before && before.stock);
  const old = number(current);
  const qty = number(fields.stock_quantity);
  if (fields.stock_mode === 'set') return qty;
  if (fields.stock_mode === 'add') return old + qty;
  return Math.max(0, old - qty);
}

function verifyProduct(item, expected) {
  if (!item) return { verified: false, message: 'The saved product could not be read back.' };
  const problems = [];
  if (expected.name !== undefined && !sameText(item.name, expected.name)) problems.push('name');
  if (expected.selling_price !== undefined && !sameNumber(item.selling_price, expected.selling_price)) problems.push('selling price');
  if (expected.company_price !== undefined && !sameNumber(item.company_price, expected.company_price)) problems.push('cost price');
  if (expected.mrp_price !== undefined && !sameNumber(item.mrp_price, expected.mrp_price)) problems.push('retail price');
  if (expected.available_quantity !== undefined && !sameNumber(item.available_quantity, expected.available_quantity)) problems.push('stock');
  if (expected.barcode_id && cleanText(item.barcode_id, 120) !== cleanText(expected.barcode_id, 120)) problems.push('barcode');
  if (expected.sku_id && cleanText(item.itemid || item.sku, 120) !== cleanText(expected.sku_id, 120)) problems.push('SKU');
  if (expected.category_id && String(item.category_id || '') !== String(expected.category_id || '')) problems.push('category');
  if (problems.length) {
    return { verified: false, message: `Saved, but the read-back did not match: ${problems.join(', ')}.` };
  }
  return { verified: true, message: 'Saved and checked.' };
}

async function executeStep(step, { api, attachments, sessionID, results, registerRollback }) {
  const fields = resolveFields(step.fields, results);
  const target = step.target !== undefined ? resolveTarget(step.target, results) : '';
  const uploaded = step.action === 'create_product' || step.action === 'update_product'
    ? await uploadImages(api, attachments, sessionID, step.images)
    : [];
  const uploadedCover = uploaded.find((image) => image.cover === 'yes') || uploaded[0] || null;
  const rollback = (undo) => {
    if (typeof registerRollback === 'function') registerRollback(undo);
  };

  if (step.action === 'create_category') {
    if (step.reuse && step.reuse.id) {
      const reusedId = String(step.reuse.id);
      return {
        id: reusedId,
        name: cleanText(step.reuse.name || fields.name, 200),
        route: '#/categories/' + encodeURIComponent(reusedId),
        verified: true,
        message: 'Existing category reused.',
        warning: '',
      };
    }
    const response = await api.post('categories', {
      name: fields.name,
      description: fields.description || '',
    });
    const id = idOf(response);
    if (!id) throw new Error('The category was saved but its id was not returned.');
    rollback(async () => {
      await api.delete('categories/' + encodeURIComponent(id));
    });
    const saved = await fetchCategory(api, id);
    if (!saved) throw new Error('The category was saved but could not be read back.');
    const verified = sameText(saved.name, fields.name);
    return {
      id,
      name: cleanText(saved.name, 200),
      route: '#/categories/' + encodeURIComponent(id),
      verified,
      message: verified ? 'Category created and checked.' : 'Category created, but the read-back did not match.',
      warning: verified ? '' : 'The saved category name did not match the plan.',
    };
  }

  if (step.action === 'update_category') {
    /* Read the live row now, not the preview snapshot: the rollback must
       restore what is there at execution time. */
    const current = await fetchCategory(api, target);
    if (!current) throw new Error('The category was not found in this branch.');
    assertSameTarget(step, current.name);
    const restore = {
      name: cleanText(current.name, 200),
      description: cleanText(current.description, 1000),
      is_active: current.active !== undefined ? current.active : current.is_active !== false,
    };
    const payload = {};
    if (fields.name !== undefined) payload.name = fields.name;
    if (fields.description !== undefined) payload.description = fields.description;
    if (fields.is_active !== undefined) payload.is_active = fields.is_active;
    await api.put('categories/' + encodeURIComponent(target), payload);
    rollback(async () => {
      await api.put('categories/' + encodeURIComponent(target), restore);
    });
    const saved = await fetchCategory(api, target);
    if (!saved) throw new Error('The category was saved but could not be read back.');
    const verified = fields.name === undefined || sameText(saved.name, fields.name);
    return {
      id: String(target),
      name: cleanText(saved.name, 200),
      route: '#/categories/' + encodeURIComponent(target),
      verified,
      message: verified ? 'Category updated and checked.' : 'Category updated, but the read-back did not match.',
      warning: verified ? '' : 'The saved category name did not match the plan.',
    };
  }

  if (step.action === 'create_product') {
    const cover = uploadedCover ? uploadedCover.name : '';
    const payload = productPayload(fields, uploaded, cover);
    const response = await api.post('items', payload);
    const id = idOf(response);
    if (!id) throw new Error('The product was saved but its id was not returned.');
    rollback(async () => {
      await api.delete('items', { data: [id] });
    });
    const saved = await fetchItem(api, id);
    const checked = verifyProduct(saved, {
      ...payload,
      available_quantity: fields.opening_stock,
      sku_id: fields.sku,
    });
    return {
      id,
      name: cleanText(saved && saved.name, 200) || fields.name,
      route: '#/items/' + encodeURIComponent(id),
      verified: checked.verified,
      message: checked.verified ? 'Product created and checked.' : checked.message,
      warning: checked.verified ? '' : checked.message,
    };
  }

  if (step.action === 'update_product') {
    const current = await fetchItem(api, target);
    if (!current) throw new Error('The product was not found in this branch.');
    assertSameTarget(step, current.name);
    const before = step.before || {
      name: current && current.name,
      images: Array.isArray(current && current.multi_image) ? current.multi_image.length : 0,
    };
    const existingImages = existingImageRows(current);
    const existingCover = cleanText(current && current.image, 300);
    let images;
    if (uploaded.length) {
      images = mergeImages(existingImages, uploaded, uploadedCover ? uploadedCover.name : existingCover);
    } else {
      images = existingImages.map((image) => ({
        ...image,
        cover: image.name === existingCover || image.cover === 'yes' ? 'yes' : 'no',
      }));
      if (images.length && !images.some((image) => image.cover === 'yes')) images[0].cover = 'yes';
    }
    const cover = images.find((image) => image.cover === 'yes');
    const base = current || {};
    const restorePayload = currentProductPayload(base, {}, existingImages, existingCover);
    const payload = currentProductPayload(base, fields, images, cover ? cover.name : '');
    await api.put('items/' + encodeURIComponent(target) + '/details', payload);
    rollback(async () => {
      await api.put('items/' + encodeURIComponent(target) + '/details', restorePayload);
    });
    const saved = await fetchItem(api, target);
    const checked = verifyProduct(saved, {
      ...payload,
      available_quantity: undefined,
    });
    return {
      id: String(target),
      name: cleanText(saved && saved.name, 200) || fields.name || before.name || '',
      route: '#/items/' + encodeURIComponent(target),
      verified: checked.verified,
      message: checked.verified ? 'Product updated and checked.' : checked.message,
      warning: checked.verified ? '' : checked.message,
    };
  }

  if (step.action === 'adjust_stock') {
    /* Read the live row now, not the preview snapshot, for the same reason
       update_category does: stock moves between the preview and Confirm.
       The expected quantity has to come from what is on the shelf today, and
       the rollback has to restore the value that was there when this step
       ran - restoring a preview-time number would put sold units back. */
    const before = await fetchItem(api, target);
    if (!before) throw new Error('The product was not found in this branch.');
    assertSameTarget(step, before.name);
    const expected = expectedStock(before, fields);
    const response = await api.post('items/stockAdjustment', {
      reason: fields.reason,
      mode: fields.stock_mode,
      note: fields.note || '',
      rows: [{ item_id: target, qty: fields.stock_quantity }],
    });
    const restoreQty = before.available_quantity !== undefined
      ? Number(before.available_quantity) || 0
      : Number(before.stock) || 0;
    rollback(async () => {
      await api.post('items/stockAdjustment', {
        reason: 'Inventory count',
        mode: 'set',
        note: 'Undone because a later assistant change failed.',
        rows: [{ item_id: target, qty: restoreQty }],
      });
    });
    const data = dataOf(response);
    const saved = await fetchItem(api, target);
    const verified = !!saved && sameNumber(saved.available_quantity, expected);
    return {
      id: String(target),
      name: cleanText((saved && saved.name) || before.name, 200),
      route: '#/items/' + encodeURIComponent(target),
      verified,
      message: verified ? 'Stock adjusted and checked.' : 'Stock adjusted, but the read-back did not match the expected quantity.',
      warning: verified ? '' : 'The saved stock did not match the expected quantity.',
      ...(data ? {} : {}),
    };
  }

  throw new Error('That action is not supported.');
}

async function executePlan(plan, { api, attachments, sessionID, onProgress, logger } = {}) {
  if (!plan || !Array.isArray(plan.steps)) throw new Error('The change plan is not valid.');
  if (!api || typeof api.get !== 'function') throw new Error('The shop data service is not available.');
  const results = new Map();
  /* Every successful write registers how to undo itself. A failure later in
     the plan runs these in reverse. The bundled MongoDB is standalone, so
     this is an all-or-compensate execution rather than a server transaction:
     it is the same pattern the stock and family writers use. */
  const rollbacks = [];
  const emit = (step, status, extra) => {
    if (typeof onProgress !== 'function') return;
    try {
      onProgress({
        planId: plan.id,
        stepId: step.id,
        action: step.action,
        status,
        message: (extra && extra.message) || '',
        result: extra && extra.result ? extra.result : null,
      });
    } catch (error) {
      /* Progress is best effort. The final response is authoritative. */
    }
  };
  const addWarning = (text) => {
    if (text && !plan.warnings.includes(text)) plan.warnings.push(text);
  };

  for (const step of plan.steps) {
    if (step.status === 'success') {
      results.set(step.id, step.result || { id: step.resultId || '', name: step.resultName || '' });
      emit(step, 'success', { message: 'Already completed.' });
      continue;
    }
    const blocked = (step.dependsOn || []).find((dep) => {
      const dependency = plan.steps.find((candidate) => candidate.id === dep);
      return !dependency || dependency.status !== 'success';
    });
    if (blocked) {
      step.status = 'skipped';
      step.message = 'Skipped because an earlier step did not finish.';
      emit(step, 'skipped', { message: step.message });
      continue;
    }

    step.status = 'running';
    step.message = '';
    emit(step, 'running', { message: 'Working...' });
    try {
      const result = await executeStep(step, {
        api,
        attachments,
        sessionID,
        results,
        registerRollback: (undo) => {
          if (typeof undo === 'function') rollbacks.push({ step, undo });
        },
      });
      step.status = 'success';
      step.result = result;
      step.resultId = result.id;
      step.resultName = result.name;
      step.message = result.message;
      step.verified = result.verified;
      if (result.warning) {
        step.warning = result.warning;
        addWarning(result.warning);
      }
      results.set(step.id, result);
      emit(step, 'success', { message: result.message, result });
    } catch (error) {
      step.status = 'failed';
      step.message = (error && error.message) || 'That step failed.';
      step.errorCode = (error && error.code) || 'step_failed';
      emit(step, 'failed', { message: step.message });
      if (typeof logger === 'function') {
        logger(`[AI plan] ${step.action} failed: ${step.errorCode}`);
      }
    }
  }

  let failed = plan.steps.filter((step) => step.status === 'failed').length;
  let skipped = plan.steps.filter((step) => step.status === 'skipped').length;
  let success = plan.steps.filter((step) => step.status === 'success').length;

  if (failed) {
    const rollbackErrors = [];
    for (let index = rollbacks.length - 1; index >= 0; index -= 1) {
      const entry = rollbacks[index];
      try {
        await entry.undo();
        if (entry.step && entry.step.status === 'success') {
          /* The write is gone, so the step is safe to run again if the user
             retries. Keep a short note instead of a result that no longer
             exists. */
          entry.step.status = 'pending';
          entry.step.message = 'Undone because the plan could not finish.';
          entry.step.warning = '';
          delete entry.step.result;
          delete entry.step.resultId;
          delete entry.step.resultName;
          delete entry.step.verified;
        } else if (entry.step && entry.step.status === 'failed') {
          entry.step.message = `${entry.step.message} Nothing from this step was kept.`;
        }
      } catch (error) {
        rollbackErrors.push((error && error.message) || 'unknown rollback error');
        if (entry.step) {
          entry.step.warning = 'This change could not be undone automatically. Review it before retrying.';
        }
      }
    }

    if (rollbackErrors.length) {
      plan.status = 'partial';
      plan.retryable = false;
      addWarning(
        'Some changes could not be undone automatically: ' +
          rollbackErrors.join(' ') +
          ' Review the affected records before trying again.'
      );
    } else {
      plan.status = 'failed';
      plan.retryable = true;
      addWarning('No changes were kept. You can retry this plan.');
    }
  } else {
    plan.status = 'completed';
    plan.retryable = false;
  }

  failed = plan.steps.filter((step) => step.status === 'failed').length;
  skipped = plan.steps.filter((step) => step.status === 'skipped').length;
  success = plan.steps.filter((step) => step.status === 'success').length;
  plan.finishedAt = Date.now();
  plan.summaryStatus = { success, failed, skipped };
  return plan;
}

module.exports = {
  executePlan,
  executeStep,
  expectedStock,
  mergeImages,
  verifyProduct,
};
