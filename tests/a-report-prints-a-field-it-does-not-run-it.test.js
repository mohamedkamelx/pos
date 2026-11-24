'use strict';
/*
 * A REPORT PRINTS WHAT A FIELD SAYS. IT DOES NOT RUN IT.
 *
 * CodeQL's js/xss-through-dom, 55 of them. The shape is always the same: a
 * value is read back out of the page - an input, a tooltip attribute, local
 * storage - and then handed to `.html()` or concatenated into a markup string.
 * At that moment it stops being a value.
 *
 * Twenty-nine of the fifty-five are these reports, and they are the ones worth
 * changing because the values are plainly text:
 *
 *   $('.from-month').html(one[0])              a month
 *   .append('<p>No Records on ' + dateRange)   a date range from a tooltip
 *
 * WHO COULD ACTUALLY DO THIS. Mostly the shop itself, which makes it
 * self-inflicted and low severity - but not entirely. A branch name is editable
 * by staff who are not the owner, and the report is opened by the owner. That
 * is somebody else's script running in a more privileged session, which is
 * worth closing even when the odds are long.
 *
 * WHAT IS DELIBERATELY NOT CHANGED, and why each one:
 *
 *   sales.js (11)   `replaceWith(rowHTMLLine)` builds a whole table row as a
 *                   string. Fixing it properly means changing how the row is
 *                   built, and this is the file where an unanchored patch once
 *                   duplicated 6,900 lines. It needs its own change.
 *   vendor (9)      slick.js, jquery.tabledit.js, jquery.calendar.js and the
 *                   two demo widgets are third-party. Patching a vendored
 *                   library is how the next upgrade silently loses the fix.
 *   main.js:289     `URL.createObjectURL(file)` is a blob URL from a file the
 *                   user chose. Not a sink.
 *   sales_view.js   `PosnicPro.record_id = $(id).data('id')` writes a variable.
 *                   Not a sink either.
 *
 * The test below proves the IDIOM, because that is the substantive claim: the
 * replacement actually escapes, and the thing it replaced actually did not.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const REPORTS = path.join(ROOT, 'frontend', 'static', 'script', 'js', 'modules', 'js');

/** A page with the real jQuery this product ships. */
function page() {
  const dom = new JSDOM('<body><div class="norecord"></div></body>', {
    url: 'https://shop.example/',
    runScripts: 'outside-only',
  });
  const jquery = fs.readFileSync(
    path.join(ROOT, 'frontend', 'static', 'script', 'js', 'jquery.min.js'),
    'utf8'
  );
  dom.window.eval(jquery);
  return dom.window;
}

/* What a staff member could put in a branch name field. */
const NASTY = '<img src=x onerror="window.__ran = 1">';

test('the old way really did run it, which is why this was worth changing', () => {
  /*
   * The half that makes the other half mean something. A fix with no
   * demonstration of the bug is a claim.
   */
  const window = page();
  const $ = window.jQuery;
  $('.norecord')
    .empty()
    .append('<div class="text-center text-dark"> <p>No Records on ' + NASTY + '</p></div>');

  const img = window.document.querySelector('.norecord img');
  assert.ok(img, 'the concatenated markup did not become a tag, so this test proves nothing');
});

test('and the new way prints it', () => {
  const window = page();
  const $ = window.jQuery;
  $('.norecord')
    .empty()
    .append(
      $('<div class="text-center text-dark"></div>').append(
        $('<p></p>').text('No Records on ' + NASTY)
      )
    );

  assert.strictEqual(
    window.document.querySelector('.norecord img'),
    null,
    'the value became a tag again'
  );
  assert.match(window.document.querySelector('.norecord p').textContent, /No Records on <img/);
});

/* --------------------------------------------------------- and it stays done */

test('no report builds its empty-state message by concatenation', () => {
  const offenders = [];
  for (const name of fs.readdirSync(REPORTS)) {
    if (!name.startsWith('report_') || !name.endsWith('.js')) continue;
    const source = fs.readFileSync(path.join(REPORTS, name), 'utf8');
    if (/No Records on ' \+ dateRange \+ '/.test(source)) offenders.push(name);
  }
  assert.deepStrictEqual(offenders, [], 'these still concatenate a DOM value into markup');
});

test('the empty-state message is still shown, in every report that had one', () => {
  /* The failure this guards against is a fix that removed the message. */
  let shown = 0;
  for (const name of fs.readdirSync(REPORTS)) {
    if (!name.startsWith('report_') || !name.endsWith('.js')) continue;
    const source = fs.readFileSync(path.join(REPORTS, name), 'utf8');
    if (/\.text\('No Records on ' \+ dateRange\)/.test(source)) shown += 1;
  }
  /* Eight reports carried this message before the complementary and
     tax report modules were removed; the seven remaining reports must keep it. */
  assert.ok(shown >= 7, 'only ' + shown + ' reports still say when they found nothing');
});
