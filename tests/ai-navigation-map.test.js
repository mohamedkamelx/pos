'use strict';

/*
 * The assistant's map of the app must match the real sidebar and the real
 * Items/Categories controls. If a label or route is renamed in the app and the
 * map is not updated in the same change, this test fails. That is the guard
 * against the assistant confidently using an old menu name.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

function sidebarEntries() {
  const html = read('frontend', 'layouts', 'sidebar.html');
  const parts = html.split(/<div class="tab-pane[^>]*id="v-pills-([^"]+)"[^>]*>/);
  const entries = [];
  for (let index = 1; index < parts.length; index += 2) {
    const body = parts[index + 1] || '';
    const groupMatch = /<h5 class="menu-title">\s*<lang[^>]*>([^<]+)<\/lang>/.exec(body);
    const group = groupMatch ? groupMatch[1].trim() : parts[index];
    const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a>/g;
    let match;
    while ((match = anchor.exec(body))) {
      const href = /href="([^"]+)"/.exec(match[1]);
      const label = /<lang[^>]*>([^<]+)<\/lang>/.exec(match[2]);
      if (!href || !label) continue;
      entries.push({
        group,
        route: href[1],
        label: label[1].trim(),
      });
    }
  }
  return entries;
}

test('every sidebar destination is in the assistant navigation map with the same menu wording', () => {
  const navigation = require(path.join(ROOT, 'src/ai/reference/navigation'));
  const entries = sidebarEntries();
  assert.ok(entries.length >= 30, 'the sidebar should expose the main destinations');

  for (const entry of entries) {
    const destination = navigation.DESTINATIONS.find((item) => item.route === entry.route);
    assert.ok(
      destination,
      `sidebar route ${entry.route} (${entry.label}) is missing from src/ai/reference/navigation.js`,
    );
    assert.equal(
      destination.menu.en[0],
      entry.group,
      `menu group for ${entry.route} should be ${entry.group}`,
    );
    assert.equal(
      destination.menu.en[destination.menu.en.length - 1],
      entry.label,
      `menu label for ${entry.route} should be ${entry.label}`,
    );
  }

  for (const destination of navigation.DESTINATIONS) {
    assert.ok(
      entries.some((entry) => entry.route === destination.route),
      `navigation map route ${destination.route} does not exist in the sidebar`,
    );
  }
});

test('the Items and Categories action map uses the visible control labels', () => {
  const navigation = require(path.join(ROOT, 'src/ai/reference/navigation'));
  const items = read('frontend', 'modules', 'items.html');
  const categories = read('frontend', 'modules', 'categories.html');
  const itemActions = navigation.get('items').actions;
  const categoryActions = navigation.get('categories').actions;

  const itemLabels = itemActions.map((action) => action.label);
  assert.ok(itemLabels.includes('New → Standard item'));
  assert.ok(itemLabels.includes('New → Bulk add'));
  assert.ok(itemLabels.includes('Tools → Stock adjustment'));
  assert.ok(itemLabels.includes('Tools → Bulk price update'));
  assert.ok(itemLabels.includes('Tools → Bulk stock update'));
  assert.ok(itemLabels.includes('Tools → Item settings'));
  assert.ok(itemLabels.includes('Tools → Product availability'));
  assert.ok(itemLabels.includes('Tools → Print shelf / product labels'));

  for (const action of itemActions) {
    const parts = action.location.match(/"([^"]+)"/g) || [];
    for (const quoted of parts) {
      const label = quoted.slice(1, -1);
      assert.ok(
        items.includes(`>${label}<`) || items.includes(`>${label} `),
        `Items page does not show the control "${label}" used by ${action.id}`,
      );
    }
  }

  assert.equal(categoryActions.length, 1);
  assert.equal(categoryActions[0].label, 'New category');
  assert.match(categories, /title="New category"/);
  assert.match(categories, /lang_addvariant_title">New</);
});
