/*
 * Put back what a person configured, after a reset.
 *
 * Run by reset.sh through mongosh once the restore has finished. reset.sh
 * has already put the pre-reset branches into `kept_branches` and restored
 * the two settings collections; this decides where all of it now belongs.
 *
 * TWO CASES, and the second is the one that matters.
 *
 * A RESTORE brings the same branch ids back, so the restored settings rows
 * already point at the branch they came from and there is nothing to do.
 *
 * A REBUILD mints new ids. The restored settings rows then point at a branch
 * that no longer exists, and the shop reads as though nothing was configured -
 * no key, no switches. That is what happened to the sandbox: the keep saved
 * everything faithfully and none of it was in force. So when none of the old
 * branch ids are present any more and there is exactly ONE shop now, the
 * settings rows are re-homed onto it. One shop is not a guess; several would
 * be, and then this does nothing and says so.
 */
const kept = db.kept_branches;
const SETTINGS = ['branch_secrets', 'branch_preferences'];

function only(collection) {
  return collection.countDocuments() === 1 ? collection.findOne({}) : null;
}

function rehome(shop) {
  for (const name of SETTINGS) {
    const collection = db.getCollection(name);
    if (!collection || collection.countDocuments() === 0) continue;
    /* An account row belongs to the licence, not to a branch, so it keeps
       its null branch and takes the new licence only. */
    collection.updateMany({ branch_id: null }, { $set: { license: shop.license } });
    collection.updateMany(
      { branch_id: { $ne: null } },
      { $set: { license: shop.license, branch_id: shop._id } }
    );
  }
}

const old = kept.find({}).toArray();
if (!old.length) {
  print('keep-branches: nothing kept');
} else {
  const live = new Set(db.branches.find({}, { _id: 1 }).toArray().map((row) => String(row._id)));
  const stale = old.filter((row) => !live.has(String(row._id)));
  const shopNow = only(db.branches);

  if (!stale.length) {
    print('keep-branches: the branch ids still match, nothing to re-home');
  } else if (shopNow) {
    rehome(shopNow);
    print(
      'keep-branches: the shop was rebuilt, so the saved settings were re-homed onto ' +
        (shopNow.branch_name || shopNow._id)
    );
  } else {
    print(
      'keep-branches: ' +
        stale.length +
        ' kept branch(es) have no home and there is not exactly one shop to' +
        ' give them to - left alone rather than guessed at'
    );
  }
}

/* The working copy is not part of the sandbox's data and must not be left
   lying in it, where the next dump would carry it into the seed. */
db.kept_branches.drop();
