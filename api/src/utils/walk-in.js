'use strict';

/*
 * THE CUSTOMER WHO DID NOT GIVE A NAME, AND THE ONE NAME FOR THEM.
 *
 * Owner: "if walk in customer no need to show. (remove it)" - about a bill
 * printing "Walk-in Customer" under the customer line.
 *
 * It was supposed to have been removed already. `bill-payload.js` had this:
 *
 *     if (name && !/^walk[\s-]?in$/i.test(name)) out.push(name);
 *
 * which matches "walkin", "walk in" and "walk-in", and does NOT match
 * "Walk-in Customer" - the name every one of this system's five install paths
 * actually writes. So the guard was real, the intent was right, and it had
 * never once matched the thing it existed to catch. A shop read the name of a
 * customer who does not exist on every cash bill it printed.
 *
 * The writer and the reader each knew a string, and the strings were not the
 * same string. So there is one here now, and `isWalkIn` is what asks.
 *
 * It stays tolerant on purpose: a shop may have typed its own version into the
 * customer record years ago, and the cost of a false positive is one bill not
 * printing a name nobody gave, while a false negative is the bug above.
 */

/*
 * The names and the matching rule live in default-parties.js, together with
 * the branch's other placeholder party. This module stays as the small,
 * focused import the bill code already uses.
 */
const { WALK_IN_NAME, isWalkIn } = require('./default-parties');

module.exports = { WALK_IN_NAME, isWalkIn };
