/*
 * Local category evidence for the assistant.
 *
 * The shop's own category list is the source of truth. This module only
 * ranks those categories against the words the user actually used, plus a
 * small bilingual retail vocabulary for common product types. It never
 * creates a category and never decides on its own when the evidence is weak:
 * weak evidence is handed back to the caller so the model can reason about
 * the full list.
 */

'use strict';

const { editDistance, normalizeName, scoreNameMatch } = require('../text-match');

const MAX_CANDIDATES = 3;
const MAX_MODEL_CANDIDATES = 5;

const STOP_WORDS = new Set([
  'منتج', 'منتجات', 'صنف', 'اصناف', 'أصناف', 'برودكت', 'product', 'products',
  'item', 'items', 'جديد', 'جديدة', 'جديده', 'new', 'اضف', 'أضف', 'اضيف',
  'أضيف', 'ضيف', 'ضيفي', 'إضافة', 'اضافة', 'انشئ', 'أنشئ', 'إنشاء', 'انشاء',
  'اعمل', 'سجل', 'add', 'create', 'please', 'pls', 'من', 'فضلك', 'لو',
  'سمحت', 'ممكن', 'عايز', 'عاوز', 'أريد', 'اريد', 'أحتاج', 'احتاج', 'i',
  'want', 'need', 'to', 'a', 'an', 'the', 'with', 'and', 'or', 'for', 'at',
  'في', 'فى', 'على', 'من', 'الى', 'إلى', 'مع', 'بسعر', 'سعر', 'السعر',
  'بيع', 'البيع', 'selling', 'sale', 'price', 'تكلفة', 'التكلفة', 'سعر',
  'الشراء', 'شراء', 'cost', 'purchase', 'كمية', 'الكمية', 'مخزون', 'المخزون',
  'عدد', 'العدد', 'stock', 'quantity', 'qty', 'count', 'فئة', 'الفئة',
  'قسم', 'تصنيف', 'category', 'categories', 'بدون', 'من', 'غير', 'no',
  'without', 'uncategorized', 'ريال', 'درهم', 'دينار', 'جنيه', 'جنية',
  'جنيها', 'egp', 'le', 'usd', 'eur', 'sar', 'aed', 'kwd', 'qar', 'omr',
  'bhd', 'jod', 'try', 'gbp', 'inch', 'in', 'cm', 'mm', 'kg', 'g', 'ml',
  'l', 'بوصة', 'بوصه', 'سم', 'مم', 'كجم', 'جم', 'مل', 'لتر',
]);

/* A retail vocabulary, not a phrasebook. Each concept lists the words a
   shopper may use and the category names a shop may use. The shop's own
   category names still win; this only widens the search when the words do not
   overlap ("iPhone" vs "موبايلات"). */
const CONCEPTS = [
  {
    id: 'mobile',
    terms: ['iphone', 'ايفون', 'آيفون', 'هاتف', 'هواتف', 'موبايل', 'موبايلات', 'جوال', 'جوالات', 'تليفون', 'تليفونات', 'phone', 'phones', 'smartphone', 'smartphones', 'mobile', 'mobiles', 'galaxy', 'samsung galaxy', 'pixel', 'huawei', 'xiaomi', 'redmi', 'oppo', 'realme', 'infinix', 'vivo', 'نوكيا', 'nokia'],
    categories: ['موبايلات', 'هواتف', 'جوالات', 'تليفونات', 'phones', 'mobiles', 'smartphones', 'mobile phones', 'إلكترونيات', 'electronics'],
  },
  {
    id: 'accessories',
    terms: ['كفر', 'جراب', 'شاحن', 'كابل', 'سماعة', 'سماعات', 'هيدفون', 'ايربودز', 'إيربودز', 'airpods', 'case', 'cover', 'charger', 'cable', 'headphone', 'headphones', 'earbuds', 'earphone', 'power bank', 'باور بانك', 'باوربانك', 'شاشة حماية', 'screen protector'],
    categories: ['إكسسوارات', 'اكسسوارات', 'accessories', 'mobile accessories', 'إكسسوارات موبايل', 'موبايلات'],
  },
  {
    id: 'computer',
    terms: ['لابتوب', 'لاب توب', 'لاب توب', 'كمبيوتر', 'كمبيوترات', 'macbook', 'ماك بوك', 'laptop', 'laptops', 'computer', 'computers', 'pc', 'desktop', 'notebook', 'chromebook', 'dell', 'hp', 'lenovo', 'asus', 'acer'],
    categories: ['لابتوب', 'لابتوبات', 'كمبيوتر', 'كمبيوترات', 'أجهزة كمبيوتر', 'اجهزة كمبيوتر', 'laptops', 'computers', 'computer', 'pc'],
  },
  {
    id: 'tablet',
    terms: ['تابلت', 'تابلوه', 'آيباد', 'ايباد', 'ipad', 'tablet', 'tablets', 'galaxy tab'],
    categories: ['تابلت', 'تابلتات', 'أجهزة لوحية', 'اجهزة لوحية', 'tablets', 'tablet'],
  },
  {
    id: 'watch',
    terms: ['ساعة', 'ساعات', 'ساعه', 'ساعه ذكية', 'ساعة ذكية', 'smartwatch', 'smart watch', 'watch', 'watches'],
    categories: ['ساعات', 'ساعة', 'watches', 'watch', 'smartwatches', 'إكسسوارات', 'اكسسوارات', 'accessories'],
  },
  {
    id: 'tv',
    terms: ['تلفزيون', 'تليفزيون', 'تلفزيونات', 'شاشة', 'شاشات', 'tv', 'tvs', 'television', 'televisions', 'screen', 'screens', 'monitor', 'monitors', 'مونيتور', 'سامسونج', 'samsung', 'lg', 'سوني', 'sony', 'tcl', 'hisense'],
    categories: ['شاشات', 'تلفزيونات', 'شاشات تلفزيون', 'تلفزيون', 'tv', 'televisions', 'screens', 'monitors', 'أجهزة كهربائية', 'اجهزة كهربائية'],
  },
  {
    id: 'appliances',
    terms: ['تلاجة', 'ثلاجة', 'تلاجات', 'ثلاجات', 'fridge', 'fridges', 'refrigerator', 'refrigerators', 'freezer', 'فريزر', 'غسالة', 'غسالات', 'washing machine', 'washer', 'dryer', 'مجفف', 'تكييف', 'تكييفات', 'مكيف', 'air conditioner', 'ac', 'بوتاجاز', 'بوتجاز', 'فرن', 'oven', 'stove', 'ميكروويف', 'microwave', 'خلاط', 'blender', 'مكنسة', 'vacuum', 'dishwasher', 'غسالة أطباق'],
    categories: ['أجهزة منزلية', 'اجهزة منزلية', 'أجهزة كهربائية', 'اجهزة كهربائية', 'home appliances', 'appliances', 'home & kitchen'],
  },
  {
    id: 'kitchen',
    terms: ['طقم', 'أطقم', 'اطقم', 'أواني', 'اواني', 'صحن', 'صحون', 'كوب', 'كوبايات', 'مطبخ', 'kitchen', 'cookware', 'dishes', 'plate', 'plates', 'cup', 'cups', 'مقلاة', 'حلة'],
    categories: ['مطبخ', 'أدوات منزلية', 'ادوات منزلية', 'kitchen', 'cookware', 'home & kitchen'],
  },
  {
    id: 'clothing',
    terms: ['قميص', 'قمصان', 'تيشيرت', 'تي شيرت', 't-shirt', 'tshirt', 'بنطلون', 'بناطيل', 'جاكيت', 'جاكت', 'فستان', 'فساتين', 'shirt', 'shirts', 'pants', 'trousers', 'jacket', 'jackets', 'dress', 'dresses', 'clothes', 'clothing', 'ملابس', 'أزياء', 'ازياء', 'fashion'],
    categories: ['ملابس', 'أزياء', 'ازياء', 'clothing', 'clothes', 'fashion', 'apparel'],
  },
  {
    id: 'shoes',
    terms: ['جزمة', 'جزامات', 'حذاء', 'أحذية', 'احذية', 'كوتشي', 'شوز', 'shoes', 'shoe', 'sneakers', 'boots', 'sandals', 'صندل'],
    categories: ['أحذية', 'احذية', 'جزامات', 'shoes', 'footwear'],
  },
  {
    id: 'bags',
    terms: ['شنطة', 'شنط', 'حقيبة', 'حقائب', 'bag', 'bags', 'backpack', 'handbag', 'حزام', 'belt', 'محفظة', 'wallet'],
    categories: ['شنط', 'حقائب', 'bags', 'accessories', 'إكسسوارات', 'اكسسوارات'],
  },
  {
    id: 'skincare',
    terms: ['كريم', 'كريمات', 'مرطب', 'سيروم', 'شامبو', 'بلسم', 'cream', 'creams', 'moisturizer', 'serum', 'shampoo', 'conditioner', 'skincare', 'skin care'],
    categories: ['العناية بالبشرة', 'عناية بالبشرة', 'skincare', 'beauty', 'personal care'],
  },
  {
    id: 'fragrance',
    terms: ['عطر', 'عطور', 'برفان', 'perfume', 'perfumes', 'cologne', 'fragrance'],
    categories: ['عطور', 'perfumes', 'fragrance', 'beauty'],
  },
  {
    id: 'makeup',
    terms: ['مكياج', 'ميك اب', 'أحمر شفاه', 'احمر شفاه', 'ماسكارا', 'makeup', 'make up', 'cosmetics', 'lipstick', 'mascara'],
    categories: ['مكياج', 'مستحضرات تجميل', 'makeup', 'cosmetics', 'beauty'],
  },
  {
    id: 'health',
    terms: ['دواء', 'أدوية', 'ادوية', 'فيتامين', 'فيتامينات', 'medicine', 'medicines', 'vitamin', 'vitamins', 'pharmacy', 'صيدلية'],
    categories: ['صيدلية', 'أدوية', 'ادوية', 'pharmacy', 'health', 'صحة'],
  },
  {
    id: 'food',
    terms: ['أكل', 'اكل', 'طعام', 'بقالة', 'مكرونة', 'رز', 'أرز', 'ارز', 'زيت', 'سكر', 'دقيق', 'food', 'foods', 'grocery', 'groceries', 'pasta', 'rice', 'oil', 'sugar', 'flour'],
    categories: ['مواد غذائية', 'بقالة', 'food', 'grocery', 'groceries', 'food & beverage'],
  },
  {
    id: 'drinks',
    terms: ['مشروب', 'مشروبات', 'عصير', 'مياه', 'مياة', 'بيبسي', 'كولا', 'drink', 'drinks', 'juice', 'water', 'soda', 'cola', 'beverage', 'beverages'],
    categories: ['مشروبات', 'drinks', 'beverages', 'food & beverage'],
  },
  {
    id: 'baby',
    terms: ['حفاض', 'حفاضات', 'بيبي', 'diaper', 'diapers', 'baby', 'رضاعة', 'رضاعات', 'baby bottle'],
    categories: ['مستلزمات أطفال', 'مستلزمات بيبي', 'baby', 'baby care', 'أطفال', 'اطفال'],
  },
  {
    id: 'toys',
    terms: ['لعبة', 'ألعاب', 'العاب', 'toy', 'toys', 'puzzle', 'بازل'],
    categories: ['ألعاب', 'العاب', 'toys', 'games'],
  },
  {
    id: 'books',
    terms: ['كتاب', 'كتب', 'book', 'books', 'رواية', 'novel'],
    categories: ['كتب', 'books', 'stationery'],
  },
  {
    id: 'stationery',
    terms: ['قلم', 'أقلام', 'اقلام', 'دفتر', 'دفاتر', 'pen', 'pens', 'notebook', 'notebooks', 'stationery', 'أدوات مكتبية', 'ادوات مكتبية'],
    categories: ['أدوات مكتبية', 'ادوات مكتبية', 'stationery', 'office supplies', 'مكتبة'],
  },
  {
    id: 'sports',
    terms: ['رياضة', 'رياضي', 'كورة', 'كره', 'جيم', 'sport', 'sports', 'football', 'gym', 'fitness', 'dumbbell', 'دامبل'],
    categories: ['رياضة', 'sports', 'fitness', 'sportswear'],
  },
  {
    id: 'auto',
    terms: ['سيارة', 'سيارات', 'كاوتش', 'إطار', 'اطار', 'زيت موتور', 'car', 'cars', 'tire', 'tires', 'motor oil', 'auto', 'automotive'],
    categories: ['سيارات', 'cars', 'auto', 'automotive', 'car accessories'],
  },
  {
    id: 'pets',
    terms: ['كلب', 'قطة', 'قطط', 'dog', 'cat', 'cats', 'pet', 'pets', 'pet food'],
    categories: ['مستلزمات حيوانات', 'حيوانات', 'pets', 'pet supplies'],
  },
  {
    id: 'cleaning',
    terms: ['منظف', 'منظفات', 'صابون', 'detergent', 'soap', 'cleaning', 'cleaner', 'cleaners'],
    categories: ['منظفات', 'cleaning', 'cleaning supplies', 'home care'],
  },
  {
    id: 'furniture',
    terms: ['كنبة', 'كنبه', 'سرير', 'كرسي', 'كراسي', 'طاولة', 'sofa', 'bed', 'chair', 'chairs', 'table', 'furniture', 'أثاث', 'اثاث'],
    categories: ['أثاث', 'اثاث', 'furniture', 'home furniture'],
  },
  {
    id: 'gifts',
    terms: ['هدية', 'هدايا', 'gift', 'gifts', 'present'],
    categories: ['هدايا', 'gifts', 'accessories'],
  },
];

const STORE_PROFILES = [
  {
    id: 'electronics',
    labels: ['electronics', 'electronic', 'mobile', 'mobiles', 'phones', 'computer', 'computers', 'technology', 'gadgets', 'electronics store', 'mobile shop', 'phone shop', 'computer store', 'technology store', 'إلكترونيات', 'الكترونيات', 'موبايلات', 'هواتف', 'جوالات', 'كمبيوتر', 'لابتوب', 'تابلت', 'شاشات', 'أجهزة كهربائية'],
    concepts: ['mobile', 'accessories', 'computer', 'tablet', 'watch', 'tv', 'electronics'],
  },
  {
    id: 'appliances',
    labels: ['home appliances', 'appliances', 'home & kitchen', 'أجهزة منزلية', 'اجهزة منزلية', 'أجهزة كهربائية', 'اجهزة كهربائية', 'مطبخ', 'أدوات منزلية', 'ادوات منزلية'],
    concepts: ['tv', 'appliances', 'kitchen', 'furniture', 'cleaning'],
  },
  {
    id: 'supermarket',
    labels: ['supermarket', 'grocery', 'groceries', 'food', 'foods', 'grocery store', 'food store', 'mini market', 'mini-market', 'hypermarket', 'department store', 'bakery', 'restaurant', 'cafe', 'coffee shop', 'butcher', 'sweets', 'بقالة', 'سوبر ماركت', 'سوبرماركت', 'ميني ماركت', 'هايبر', 'مواد غذائية', 'مشروبات', 'أكل', 'اكل', 'مخبز', 'مطعم', 'كافيه', 'جزارة', 'حلواني'],
    concepts: ['food', 'drinks', 'cleaning', 'baby'],
  },
  {
    id: 'pharmacy',
    labels: ['pharmacy', 'health', 'medical', 'drug store', 'drugstore', 'medical store', 'optical', 'eyewear', 'صيدلية', 'أدوية', 'ادوية', 'صحة', 'طبي', 'بصريات', 'نظارات'],
    concepts: ['health', 'skincare', 'baby'],
  },
  {
    id: 'beauty',
    labels: ['beauty', 'cosmetics', 'perfume', 'perfumes', 'skincare', 'beauty store', 'cosmetics store', 'salon', 'spa', 'تجميل', 'مستحضرات تجميل', 'عطور', 'العناية بالبشرة', 'عناية بالبشرة', 'مكياج', 'صالون', 'سبا'],
    concepts: ['skincare', 'fragrance', 'makeup', 'health'],
  },
  {
    id: 'fashion',
    labels: ['fashion', 'clothing', 'clothes', 'apparel', 'footwear', 'fashion store', 'clothing store', 'shoe store', 'boutique', 'jewelry', 'jewellery', 'watches', 'ملابس', 'أزياء', 'ازياء', 'أحذية', 'احذية', 'شنط', 'حقائب', 'موضة', 'بوتيك', 'مجوهرات', 'ذهب', 'ساعات'],
    concepts: ['clothing', 'shoes', 'bags', 'accessories', 'watch'],
  },
  {
    id: 'home',
    labels: ['home', 'furniture', 'kitchen', 'home store', 'furniture store', 'hardware', 'hardware store', 'tools', 'construction', 'أثاث', 'اثاث', 'مطبخ', 'أدوات منزلية', 'ادوات منزلية', 'منزل', 'عدد وأدوات', 'مواد بناء'],
    concepts: ['appliances', 'kitchen', 'furniture', 'cleaning'],
  },
  {
    id: 'kids',
    labels: ['kids', 'baby', 'toys', 'toy store', 'baby store', 'games', 'أطفال', 'اطفال', 'مستلزمات أطفال', 'مستلزمات بيبي', 'ألعاب', 'العاب'],
    concepts: ['baby', 'toys', 'clothing', 'stationery'],
  },
  {
    id: 'sports',
    labels: ['sports', 'sport', 'fitness', 'sports store', 'gym', 'رياضة', 'رياضي', 'لياقة'],
    concepts: ['sports', 'clothing', 'shoes'],
  },
  {
    id: 'auto',
    labels: ['auto', 'automotive', 'cars', 'car', 'car accessories', 'auto parts', 'spare parts', 'سيارات', 'سيارة', 'مستلزمات سيارات', 'قطع غيار'],
    concepts: ['auto'],
  },
  {
    id: 'pets',
    labels: ['pets', 'pet', 'pet shop', 'pet store', 'حيوانات', 'مستلزمات حيوانات'],
    concepts: ['pets'],
  },
  {
    id: 'books',
    labels: ['books', 'book', 'stationery', 'bookstore', 'book shop', 'stationery store', 'office supplies', 'كتب', 'أدوات مكتبية', 'ادوات مكتبية', 'مكتبة'],
    concepts: ['books', 'stationery'],
  },
  {
    id: 'gifts',
    labels: ['gifts', 'gift', 'gift shop', 'flower shop', 'florist', 'flowers', 'هدايا', 'هدية', 'زهور', 'ورد'],
    concepts: ['gifts', 'accessories', 'fragrance', 'makeup'],
  },
];

const GENERIC_NAMES = new Set([
  'أخرى', 'اخرى', 'اخري', 'عام', 'عامة', 'متنوع', 'متنوعة', 'غير مصنف',
  'بدون تصنيف', 'other', 'others', 'general', 'misc', 'miscellaneous',
  'uncategorized', 'no category', 'غير محدد',
]);

const UNIT_PATTERNS = [
  /(\d+)\s*(gb|mb|tb|ram|جيجا|جيجابايت|ميجا|تيرا|رام)/giu,
  /(\d+)\s*(inch|in|cm|mm|بوصة|بوصه|سم|مم)/giu,
];

function arabicText(value) {
  return /[\u0600-\u06FF]/.test(String(value || ''));
}

const AUDIENCE_HINTS = new Set([
  'أطفال', 'اطفال', 'رجالي', 'نسائي', 'حريمي', 'ولادي', 'بناتي', 'men',
  'women', 'kids', 'baby', 'unisex', 'children',
]);

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tokenize(value) {
  const normalized = String(value || '')
    .toLowerCase()
    .replace(/(\p{L})(\p{N})/gu, '$1 $2')
    .replace(/(\p{N})(\p{L})/gu, '$1 $2')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  if (!normalized) return [];
  return normalized.split(/\s+/).filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

function compactUnitVariants(value) {
  const text = String(value || '');
  const variants = [];
  for (const regex of UNIT_PATTERNS) {
    for (const match of text.matchAll(regex)) {
      const number = match[1];
      const unit = match[2];
      variants.push(`${number} ${unit}`, `${number}${unit}`);
    }
  }
  return variants;
}

/* A short brand such as "سوني" must not match inside "بنسونيك". Token
   equality covers most words; longer phrases and brand strings use a
   letter-boundary check. */
function termMatches(text, tokens, term) {
  const wanted = String(term || '').toLowerCase();
  if (!wanted) return false;
  if (tokens.has(wanted)) return true;
  if (wanted.includes(' ')) return text.includes(wanted);
  if (wanted.length < 4) return false;
  /* One dropped or transposed letter in a longer word ("iphon" for "iphone",
     "labtop" for "laptop") should still reach the concept. Short words stay
     exact so "case" does not match unrelated four-letter words. */
  if (wanted.length >= 5) {
    for (const token of tokens) {
      if (token.length >= 5 && token[0] === wanted[0] &&
          Math.abs(token.length - wanted.length) <= 1 &&
          editDistance(token, wanted) <= 1) {
        return true;
      }
    }
  }
  const regex = new RegExp(
    `(?:^|[^\\p{L}\\p{N}])${escapeRegExp(wanted)}(?:$|[^\\p{L}\\p{N}])`,
    'iu',
  );
  return regex.test(text);
}

function storeTypeValues(storeType) {
  const raw = Array.isArray(storeType) ? storeType : [storeType];
  const values = [];
  for (const entry of raw) {
    const text = String(entry == null ? '' : entry);
    for (const part of text.split(/[,;|]+/)) {
      const value = part.trim();
      if (value) values.push(value);
    }
  }
  return values;
}

function profileIdsForStoreType(storeType) {
  const values = storeTypeValues(storeType);
  const ids = new Set();
  for (const value of values) {
    const wanted = normalizeName(value);
    if (!wanted) continue;
    for (const profile of STORE_PROFILES) {
      if (profile.id === wanted) {
        ids.add(profile.id);
        continue;
      }
      const matches = profile.labels.some((label) => {
        const normalized = normalizeName(label);
        return normalized === wanted || normalized.includes(wanted) || wanted.includes(normalized);
      });
      if (matches) ids.add(profile.id);
    }
  }
  return [...ids];
}

/* The store type is chosen on the registration form and is authoritative.
   This inference is only for shops installed before that field existed: a
   mobile shop has "موبايلات"; a clothing shop has "ملابس". An empty
   catalogue returns no profile, so every concept stays available. */
function inferStoreProfiles({ categories = [], products = [] } = {}) {
  const names = [
    ...(Array.isArray(categories) ? categories : []).map((category) => category && category.name),
    ...(Array.isArray(products) ? products : []).map((product) => product && product.name),
  ].filter(Boolean);
  if (!names.length) {
    return { profiles: [], confidence: 'unknown', scores: [] };
  }
  const text = names.join(' ').toLowerCase();
  const tokens = new Set(tokenize(text));
  const scores = [];
  for (const profile of STORE_PROFILES) {
    let score = 0;
    const matched = [];
    for (const label of profile.labels) {
      if (termMatches(text, tokens, label)) {
        score += 10;
        matched.push(label);
      }
    }
    if (score > 0) scores.push({ id: profile.id, score, matched });
  }
  scores.sort((left, right) => right.score - left.score);
  if (!scores.length) {
    return { profiles: [], confidence: 'unknown', scores: [] };
  }
  const top = scores[0];
  const profiles = scores
    .filter((entry) => entry.score >= Math.max(10, top.score * 0.35))
    .slice(0, 3)
    .map((entry) => entry.id);
  return {
    profiles,
    confidence: top.score >= 20 ? 'high' : 'medium',
    scores,
  };
}

function conceptsForProfiles(profiles) {
  if (!Array.isArray(profiles) || !profiles.length) return CONCEPTS;
  const allowed = new Set();
  for (const profile of STORE_PROFILES) {
    if (!profiles.includes(profile.id)) continue;
    for (const conceptId of profile.concepts) allowed.add(conceptId);
  }
  const filtered = CONCEPTS.filter((concept) => allowed.has(concept.id));
  return filtered.length ? filtered : CONCEPTS;
}

function conceptMatches(value, concepts = CONCEPTS) {
  const text = String(value || '').toLowerCase();
  const tokens = new Set(tokenize(text));
  const hints = new Set();
  const matchedTerms = [];
  for (const concept of concepts) {
    let matched = false;
    for (const term of concept.terms) {
      if (termMatches(text, tokens, term)) {
        matched = true;
        matchedTerms.push(term);
        break;
      }
    }
    if (matched) {
      for (const category of concept.categories) hints.add(category);
    }
  }
  return { hints: [...hints], terms: matchedTerms };
}

function expandKeywords(name, message, concepts = CONCEPTS) {
  const words = new Set([
    ...tokenize(name),
    ...tokenize(message),
    ...compactUnitVariants(`${name} ${message}`),
  ]);
  const matched = conceptMatches(`${name} ${message}`, concepts);
  for (const hint of matched.hints) {
    for (const token of tokenize(hint)) words.add(token);
  }
  return {
    keywords: [...words].filter(Boolean).slice(0, 40),
    hints: matched.hints,
    matchedTerms: matched.terms,
  };
}

function isGenericCategory(name) {
  const normalized = normalizeName(name);
  return GENERIC_NAMES.has(normalized);
}

function categoryTokens(category) {
  return new Set(tokenize(category && category.name));
}

function scoreCategory(category, productName, keywords, hints, searchHits) {
  const name = String((category && category.name) || '');
  if (!name) return null;
  const normalized = normalizeName(name);
  const tokens = categoryTokens(category);
  const productTokens = tokenize(productName);
  const reasons = [];
  let score = 0;

  if (normalized && normalized === normalizeName(productName)) {
    score += 100;
    reasons.push('exact name');
  }

  for (const keyword of keywords) {
    const wanted = normalizeName(keyword);
    if (!wanted) continue;
    if (normalized === wanted) {
      score += 90;
      reasons.push(`exact "${keyword}"`);
      break;
    }
    /* A two- or three-letter brand must be its own word. Without this, "ac"
       (air conditioner) would match "accessories" and "hp" would match
       unrelated words. Longer words may still match a stem or plural. */
    const short = wanted.length < 4;
    const matches = short
      ? tokens.has(wanted)
      : (normalized.includes(wanted) || wanted.includes(normalized));
    if (matches) {
      score += 55;
      reasons.push(`contains "${keyword}"`);
      break;
    }
  }

  let overlap = 0;
  const overlapTokens = [];
  for (const token of productTokens) {
    if (tokens.has(token)) {
      overlap += 1;
      overlapTokens.push(token);
    }
  }
  if (overlap) {
    score += Math.min(60, overlap * 25);
    reasons.push('shared words');
  }

  const fuzzy = scoreNameMatch(productName, name);
  if (fuzzy > 0) {
    score += Math.round(fuzzy * 45);
    if (fuzzy >= 0.55) reasons.push('close spelling');
  }

  let hintScore = 0;
  let audienceOnly = false;
  let productTypeHint = false;
  for (const hint of hints) {
    const wanted = normalizeName(hint);
    if (!wanted) continue;
    const audience = AUDIENCE_HINTS.has(wanted);
    const matches = normalized === wanted ||
      termMatches(normalized, tokens, wanted) ||
      (wanted.length >= 4 && normalized.length >= 4 && wanted.includes(normalized));
    if (matches) {
      const exact = normalized === wanted;
      hintScore = Math.max(hintScore, audience ? (exact ? 30 : 20) : (exact ? 80 : 55));
      reasons.push(audience ? `audience "${hint}"` : `type "${hint}"`);
      if (audience) audienceOnly = true;
      else productTypeHint = true;
    }
  }
  score += hintScore;

  if (searchHits && searchHits.has(normalized)) {
    score += 25;
    reasons.push('search match');
  }

  if (isGenericCategory(name)) {
    score -= 30;
    reasons.push('generic');
  }

  if (Number(category && category.itemCount) > 0) score += 2;

  const audienceTokens = new Set([...AUDIENCE_HINTS]);
  const overlapAudience = overlapTokens.length > 0 &&
    overlapTokens.every((token) => audienceTokens.has(token));
  const onlyAudience = !productTypeHint && (audienceOnly || overlapAudience);

  return { score: Math.max(0, score), reasons, audienceOnly: onlyAudience };
}

function rankCategories({
  name,
  message = '',
  categories = [],
  searchHits = [],
  storeType = null,
  products = [],
} = {}) {
  const productName = String(name || '').trim();
  const hasStoreType = storeTypeValues(storeType).length > 0;
  const inference = inferStoreProfiles({ categories, products });
  const explicitProfiles = profileIdsForStoreType(storeType);
  /* A registered type that this vocabulary does not know is still a
     decision: do not replace it with a guess from the category names. Use
     every concept instead. Only a shop with no registered type at all gets
     the legacy inference fallback. */
  const storeProfiles = explicitProfiles.length
    ? explicitProfiles
    : (hasStoreType ? [] : inference.profiles);
  const storeConfidence = explicitProfiles.length
    ? 'explicit'
    : (hasStoreType ? 'unmapped' : inference.confidence);
  const concepts = conceptsForProfiles(storeProfiles);
  const expansion = expandKeywords(productName, message, concepts);
  const hitSet = new Set((searchHits || []).map((value) => normalizeName(value)));
  const ranked = [];

  for (const category of categories || []) {
    if (!category || !category.name) continue;
    const result = scoreCategory(category, productName, expansion.keywords, expansion.hints, hitSet);
    if (!result || result.score < 30) continue;
    ranked.push({
      id: String(category.id || ''),
      name: String(category.name),
      score: result.score,
      reasons: result.reasons,
      audienceOnly: result.audienceOnly,
      itemCount: category.itemCount == null ? null : category.itemCount,
    });
  }

  ranked.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.name.localeCompare(right.name);
  });

  const seen = new Set();
  const unique = [];
  for (const candidate of ranked) {
    const key = normalizeName(candidate.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }

  const topScore = unique[0] ? unique[0].score : 0;
  const minScore = Math.max(30, Math.round(topScore * 0.4));
  const candidates = unique.filter((candidate) => candidate.score >= minScore).slice(0, MAX_CANDIDATES);
  const recommended = candidates[0] || null;
  let confidence = 'low';
  if (!categories || !categories.length) {
    confidence = 'empty';
  } else if (recommended) {
    const second = candidates[1];
    const margin = second ? recommended.score - second.score : recommended.score;
    if (recommended.score >= 70 && (margin >= 15 || recommended.score >= 90)) {
      confidence = 'high';
    } else if (recommended.score >= 45 && margin >= 8) {
      confidence = 'medium';
    }
    /* A match only through an audience word ("أطفال", "رجالي") is a
       plausible category, not proof. Ask instead of auto-selecting it. */
    if (recommended.audienceOnly && confidence === 'high') confidence = 'medium';
  }

  return {
    confidence,
    recommended,
    candidates,
    modelCandidates: unique.slice(0, MAX_MODEL_CANDIDATES),
    keywords: expansion.keywords,
    hints: expansion.hints,
    matchedTerms: expansion.matchedTerms,
    suggestedName: suggestedCategoryName(expansion.hints, productName),
    storeType: storeTypeValues(storeType).join(', '),
    storeProfiles,
    storeConfidence,
    storeScores: inference.scores,
  };
}

function suggestedCategoryName(hints, productName) {
  for (const hint of hints || []) {
    const normalized = normalizeName(hint);
    if (!normalized || isGenericCategory(hint)) continue;
    if (normalized.length < 2) continue;
    return hint;
  }
  const tokens = tokenize(productName).filter((token) => !/\d/.test(token));
  if (tokens.length === 1 && tokens[0].length >= 3) {
    return tokens[0];
  }
  return '';
}

function modelCategoryContext({ draft, ranking, categories = [] } = {}) {
  const all = Array.isArray(categories) ? categories : [];
  const names = all.length <= 40
    ? all.map((category) => category.name).filter(Boolean)
    : (ranking && ranking.modelCandidates ? ranking.modelCandidates.map((category) => category.name) : []);
  return {
    operation: 'create_product',
    draft,
    categoryConfidence: ranking ? ranking.confidence : 'low',
    categoryCandidates: ranking && ranking.modelCandidates
      ? ranking.modelCandidates.map((candidate) => ({
        name: candidate.name,
        score: candidate.score,
        reasons: candidate.reasons,
      }))
      : [],
    categoryNames: names,
    suggestedName: ranking ? ranking.suggestedName : '',
    instruction: [
      'Choose a category for this product only from the candidate names or the category list.',
      'If none fits, ask once whether to create a new category or leave the product uncategorized.',
      'Do not ask for a value that is already in the draft.',
      'Do not invent a form; use posnic_ask_user or posnic_propose_plan.',
    ].join(' '),
  };
}

module.exports = {
  CONCEPTS,
  STORE_PROFILES,
  conceptsForProfiles,
  expandKeywords,
  inferStoreProfiles,
  isGenericCategory,
  modelCategoryContext,
  profileIdsForStoreType,
  rankCategories,
  storeTypeValues,
  suggestedCategoryName,
  tokenize,
};
