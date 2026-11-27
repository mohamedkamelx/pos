/* Category vocabulary shared by the local parser and the ask-user tool.
   One owner: the two copies of the stop-word set diverged once already and
   "في قسم الأدوات الكهربائية بـ 3000" carried "بـ" into the category value. */

const CATEGORY_STOP_WORDS = new Set([
  'و', 'أو', 'او', 'ثم', 'بس', 'بـ', 'بسعر', 'سعر', 'السعر', 'وكمية', 'كمية',
  'الكمية', 'وتكلفة', 'تكلفة', 'التكلفة', 'ووصف', 'وصف', 'الوصف', 'وخلي',
  'خلي', 'خلى', 'ويكون', 'يكون', 'علشان', 'عشان', 'مع', 'في', 'فى', 'من',
  'الى', 'إلى', 'على', 'والتكلفة', 'والكمية', 'والوصف', 'جديدة', 'جديد',
  'new', 'and', 'with', 'for', 'price', 'cost', 'stock', 'quantity',
  'description',
]);

/* A category name ends where the next field, number or clause begins:
   "في قسم الأدوات الكهربائية بـ 3000" must not carry "بـ" into the
   category, "وحطها في الأدوات الكهربائية والكمية 7" must not eat the
   quantity, and a number can never join a category name. The و and ال are
   optional independently so "السعر" stops as well as "والسعر". The field
   words and verbs stop only at a word end, so خليط, حطب and سعرات stay
   category words; عدد stops only in front of a digits, because العدد
   والأدوات is a shelf and "عدد 5" is a quantity. */
const CATEGORY_STOP = String.raw`(?!بـ|ب(?=\s*\d)|[\d٠-٩]|(?:و|ب)?(?:ال)?(?:بسعر|سعر|تكلف[ةه]|كمي[ةه]|مخزون|باركود|خلي|حط|ضيف)(?![\p{L}\p{N}])|عدد(?=\s*\d))`;
const CATEGORY_TOKEN = String.raw`[^\s،,.!?]+`;
const CATEGORY_PHRASE_RE = new RegExp(
  String.raw`(?:^|[^\p{L}\p{N}])(?:في|فى|داخل|ضمن|in|under)\s+(?:فئة|قسم|تصنيف|category)\s+(${CATEGORY_STOP}${CATEGORY_TOKEN}(?:\s+${CATEGORY_STOP}${CATEGORY_TOKEN}){0,2})`,
  'iu',
);

module.exports = {
  CATEGORY_STOP_WORDS,
  CATEGORY_STOP,
  CATEGORY_TOKEN,
  CATEGORY_PHRASE_RE,
};
