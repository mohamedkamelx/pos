'use strict';

/*
 * THE TWO PLACEHOLDER PARTIES EVERY BRANCH STARTS WITH.
 *
 * A shop that has not named a cash customer still needs a real customer record
 * to attach a sale to, and the same is true of a supplier for the first
 * purchase. Those records used to be written in English on every install path,
 * even when the shop's language was Arabic. The names are data, not interface
 * labels, so the language catalog could not translate them.
 *
 * They are written in Arabic now. Both the old and new spellings are accepted
 * when the code has to decide whether a record is the placeholder, because a
 * shop upgrading in place still has the old names in its database until the
 * data migration runs.
 */

const WALK_IN_NAME = 'زبون محل';
const GENERAL_SUPPLIER_NAME = 'مورد عام';

/*
 * walk in / walkin / walk-in, on its own or followed by a word like customer
 * or guest. Anchored at the front so a real person called "Walkinshaw" is not
 * quietly erased from their own bill.
 *
 * The Arabic spellings cover the current default ("زبون محل"), the same name
 * with the article ("زبون المحل"), and the older UI wording ("عميل عابر",
 * "زبون عابر"). A shop may also have typed one of these by hand years ago.
 */
const WALK_IN_PATTERN =
  /^(?:walk[\s._-]?in\b[\s._-]*(?:customer|guest|client)?|زبون\s*(?:ال)?محل|(?:عميل|زبون)\s*عابر)$/i;

const GENERAL_SUPPLIER_PATTERN = /^(?:general\s+supplier|مورد\s+عام|المورد\s+العام)$/i;

const textOf = (value) => String(value == null ? '' : value).trim();

/**
 * Is this the placeholder rather than a person?
 *
 * @param {unknown} name
 * @returns {boolean}
 */
function isWalkIn(name) {
  const text = textOf(name);
  return !!text && WALK_IN_PATTERN.test(text);
}

/**
 * Is this the branch's default supplier placeholder?
 *
 * @param {unknown} name
 * @returns {boolean}
 */
function isGeneralSupplier(name) {
  const text = textOf(name);
  return !!text && GENERAL_SUPPLIER_PATTERN.test(text);
}

module.exports = {
  WALK_IN_NAME,
  GENERAL_SUPPLIER_NAME,
  WALK_IN_PATTERN,
  GENERAL_SUPPLIER_PATTERN,
  isWalkIn,
  isGeneralSupplier,
};
