/*
 * One folding rule for names that may be written two ways.
 *
 * An Arabic product name is typed differently by different people and by the
 * same person twice: hamza on a seat or standing, ى for ي, ة for ه, tatweel
 * for emphasis, tashkeel for nothing at all, Persian digits, invisible bidi
 * marks pasted from a chat. If two spellings of one name fold to different
 * keys, a record the operator just saw stops resolving and its id is lost.
 *
 * The rule is deliberately generous: over-folding is safe here because every
 * caller refuses to act on an ambiguous match. Two rows folding to one key
 * means "no answer", never "the first one".
 *
 * This is the only place that decides what "the same name" means. recordFor
 * joins records with it; anything else that has to recognise a name twice
 * imports it rather than growing its own chain.
 */

'use strict';

/* Bidi controls and zero-width characters: invisible, and very common in
   text pasted from an RTL chat. */
const BIDI_RE = /[​-‏‪-‮⁦-⁩﻿]/g;
/* Tatweel and every combining mark: tashkeel, hamza and madda seats. */
const MARKS_RE = /[ـ\p{M}]/gu;
const ARABIC_DIGIT_RE = /[٠-٩]/g;
const PERSIAN_DIGIT_RE = /[۰-۹]/g;
const NON_NAME_RE = /[^\p{L}\p{N}.%+\s]/gu;

function foldName(value) {
  return String(value == null ? '' : value)
    /* Lam-alef ligatures and presentation forms decompose first, so hamza
       and madda become base letter + mark and are removed with the marks
       below. NFKD turns ؤ into و and ئ into ي for free; ء stays. */
    .normalize('NFKD')
    .replace(BIDI_RE, '')
    .replace(MARKS_RE, '')
    /* Persian and Arabic-Indic digits to Latin, so ٥٠ and 50 are one name. */
    .replace(ARABIC_DIGIT_RE, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(PERSIAN_DIGIT_RE, (digit) => String(digit.charCodeAt(0) - 0x06F0))
    /* The alef family folds to one alef; Egyptian typing mixes ى and ي, and
       Persian ک has no business separating a name from its own spelling. */
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/[ىی]/g, 'ي')
    .replace(/ک/g, 'ك')
    .replace(/ة/g, 'ه')
    .toLowerCase()
    /* Everything that is not part of a name becomes a space, so punctuation
       and emoji cannot split two spellings of the same name. */
    .replace(NON_NAME_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { foldName };
