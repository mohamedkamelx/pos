/*
 * The assistant's map of Posnic.
 *
 * Every entry here is a real destination taken from the sidebar and the page
 * markup. The help tool returns these paths verbatim; it must never invent a
 * menu name or a button position. When a route or label changes, change it
 * here in the same commit.
 *
 * `permission` is the ACL pair the page itself uses. It is descriptive: the
 * API still enforces access, and the assistant never bypasses it.
 */

'use strict';

const DESTINATIONS = [
  {
    id: 'dashboard',
    label: { en: 'Dashboard', ar: 'لوحة التحكم' },
    menu: { en: ['Home', 'Dashboard'], ar: ['الرئيسية', 'لوحة التحكم'] },
    route: '#/dashboard',
    page: 'Dashboard',
    description: 'The shop home screen with today\'s sales, stock and activity.',
    permission: ['dashboard', 'read'],
    actions: [],
  },
  {
    id: 'new-sale',
    label: { en: 'New Sale', ar: 'بيع جديد' },
    menu: { en: ['Home', 'New Sale'], ar: ['الرئيسية', 'بيع جديد'] },
    route: '#/sales/new',
    page: 'New Sale',
    description: 'The till screen for starting a sale, adding products and taking payment.',
    permission: ['sales', 'write'],
    actions: [],
  },
  {
    id: 'sales-history',
    label: { en: 'Sales History', ar: 'سجل المبيعات' },
    menu: { en: ['Home', 'Sales History'], ar: ['الرئيسية', 'سجل المبيعات'] },
    route: '#/sales',
    page: 'Sales History',
    description: 'Completed, held and returned sales for the current branch.',
    permission: ['sales', 'read'],
    actions: [],
  },
  {
    id: 'purchases',
    label: { en: 'Purchases', ar: 'المشتريات' },
    menu: { en: ['Purchase', 'Purchases'], ar: ['المشتريات', 'المشتريات'] },
    route: '#/purchaseorders',
    page: 'Purchases',
    description: 'Purchase orders and receiving stock from suppliers.',
    permission: ['receiving', 'read'],
    actions: [],
  },
  {
    id: 'suppliers',
    label: { en: 'Supplier List', ar: 'قائمة الموردين' },
    menu: { en: ['Purchase', 'Supplier List'], ar: ['المشتريات', 'قائمة الموردين'] },
    route: '#/suppliers',
    page: 'Supplier List',
    description: 'The shops and people the shop buys stock from.',
    permission: ['supplier', 'read'],
    actions: [],
  },
  {
    id: 'items',
    label: { en: 'Items', ar: 'الأصناف' },
    menu: { en: ['Inventory', 'Items'], ar: ['المخزون', 'الأصناف'] },
    route: '#/items',
    page: 'Item List',
    description: 'The product list for the current branch. Search, filter, open a product, and use the top-right controls.',
    aliases: [
      'add a product', 'add product', 'new product', 'create product',
      'add an item', 'add item', 'new item', 'create item', 'product list',
      'قائمة الأصناف', 'إضافة صنف', 'صنف جديد', 'منتج جديد',
    ],
    permission: ['item', 'read'],
    actions: [
      {
        id: 'add-standard-item',
        label: { en: 'New → Standard item', ar: 'جديد ← صنف قياسي' },
        route: '#/items/new',
        location: 'Items page, top-right "New" dropdown, then "Standard item".',
        aliases: [
          'add a product', 'add product', 'new product', 'create product',
          'add an item', 'add item', 'new item', 'create item',
          'إضافة صنف', 'صنف جديد', 'منتج جديد',
        ],
        permission: ['item', 'write'],
      },
      {
        id: 'bulk-add-items',
        label: { en: 'New → Bulk add', ar: 'جديد ← إضافة دفعة' },
        route: '#/bulkitems',
        location: 'Items page, top-right "New" dropdown, then "Bulk add".',
        aliases: ['bulk add products', 'import products', 'إضافة أصناف بالجملة'],
        permission: ['item', 'write'],
      },
      {
        id: 'stock-adjustment',
        label: { en: 'Tools → Stock adjustment', ar: 'الأدوات ← تسوية المخزون' },
        route: '#/items',
        location: 'Items page, top-right "Tools" dropdown, then "Stock adjustment".',
        aliases: ['adjust stock', 'stock adjustment', 'change stock', 'تسوية المخزون', 'تعديل المخزون'],
        permission: ['item', 'write'],
      },
      {
        id: 'product-availability',
        label: { en: 'Tools → Product availability', ar: 'الأدوات ← توفر المنتج' },
        route: '#/items',
        location: 'Items page, top-right "Tools" dropdown, then "Product availability".',
        aliases: ['product availability', 'check availability', 'توفر المنتج', 'توفر الأصناف'],
        permission: ['item', 'read'],
      },
      {
        id: 'print-shelf-labels',
        label: { en: 'Tools → Print shelf / product labels', ar: 'الأدوات ← طباعة ملصقات الرفوف / المنتجات' },
        route: '#/items',
        location: 'Items page, top-right "Tools" dropdown, then "Print shelf / product labels".',
        aliases: ['print labels', 'shelf labels', 'product labels', 'طباعة الملصقات', 'ملصقات الرفوف'],
        permission: ['item', 'read'],
      },
      {
        id: 'bulk-price-update',
        label: { en: 'Tools → Bulk price update', ar: 'الأدوات ← تحديث الأسعار بالجملة' },
        route: '#/items',
        location: 'Items page, top-right "Tools" dropdown, then "Bulk price update".',
        aliases: ['bulk price update', 'update prices', 'change prices', 'تحديث الأسعار'],
        permission: ['item', 'write'],
      },
      {
        id: 'bulk-stock-update',
        label: { en: 'Tools → Bulk stock update', ar: 'الأدوات ← تحديث المخزون بالجملة' },
        route: '#/items',
        location: 'Items page, top-right "Tools" dropdown, then "Bulk stock update".',
        aliases: ['bulk stock update', 'update stock', 'تحديث المخزون'],
        permission: ['item', 'write'],
      },
      {
        id: 'item-settings',
        label: { en: 'Tools → Item settings', ar: 'الأدوات ← إعدادات الأصناف' },
        route: '#/itemsettings',
        location: 'Items page, top-right "Tools" dropdown, then "Item settings".',
        aliases: ['item settings', 'product settings', 'إعدادات الأصناف'],
        permission: ['item', 'read'],
      },
    ],
  },
  {
    id: 'price-settings',
    label: { en: 'Price Settings', ar: 'إعدادات الأسعار' },
    menu: { en: ['Inventory', 'Price Settings'], ar: ['المخزون', 'إعدادات الأسعار'] },
    route: '#/pricesettings',
    page: 'Price Settings',
    description: 'Shop-wide price rules and price-related settings.',
    permission: ['item', 'read'],
    actions: [],
  },
  {
    id: 'categories',
    label: { en: 'Categories', ar: 'الفئات' },
    menu: { en: ['Inventory', 'Categories'], ar: ['المخزون', 'الفئات'] },
    route: '#/categories',
    page: 'Categories',
    description: 'Product groups used to organise the catalogue and filter lists.',
    aliases: [
      'add a category', 'add category', 'new category', 'create category',
      'product group', 'إضافة فئة', 'فئة جديدة', 'مجموعة أصناف',
    ],
    permission: ['category', 'read'],
    actions: [
      {
        id: 'add-category',
        label: { en: 'New category', ar: 'فئة جديدة' },
        route: '#/categories/new',
        location: 'Categories page, top-right "New" button (tooltip "New category").',
        aliases: ['add a category', 'add category', 'new category', 'create category', 'إضافة فئة', 'فئة جديدة'],
        permission: ['category', 'write'],
      },
    ],
  },
  {
    id: 'expiry-list',
    label: { en: 'Expiry list', ar: 'قائمة الصلاحية' },
    menu: { en: ['Inventory', 'Expiry list'], ar: ['المخزون', 'قائمة الصلاحية'] },
    route: '#/expiryreport',
    page: 'Expiry list',
    description: 'Products approaching or past their expiry date.',
    permission: ['item', 'read'],
    actions: [],
  },
  {
    id: 'stock-counts',
    label: { en: 'Stock Counts', ar: 'جرد المخزون' },
    menu: { en: ['Inventory', 'Stock Counts'], ar: ['المخزون', 'جرد المخزون'] },
    route: '#/inventorycounts',
    page: 'Stock Counts',
    description: 'Count worksheets and stock audit adjustments.',
    permission: ['item', 'read'],
    actions: [],
  },
  {
    id: 'customers',
    label: { en: 'Customer List', ar: 'قائمة العملاء' },
    menu: { en: ['Customers', 'Customer List'], ar: ['العملاء', 'قائمة العملاء'] },
    route: '#/customers',
    page: 'Customer List',
    description: 'Customer records, balances and contact details.',
    permission: ['customer', 'read'],
    actions: [],
  },
  {
    id: 'customer-categories',
    label: { en: 'Customer Category', ar: 'فئات العملاء' },
    menu: { en: ['Customers', 'Customer Category'], ar: ['العملاء', 'فئات العملاء'] },
    route: '#/customercategory',
    page: 'Customer Category',
    description: 'Customer groups and pricing groups.',
    permission: ['plan', 'read'],
    actions: [],
  },
  {
    id: 'catalog-display',
    label: { en: 'Catalog Display', ar: 'عرض الكتالوج' },
    menu: { en: ['Customers', 'Catalog Display'], ar: ['العملاء', 'عرض الكتالوج'] },
    route: 'customersearch.html',
    page: 'Catalog Display',
    description: 'A customer-facing catalogue window. It opens in a new window.',
    permission: ['plan', 'read'],
    actions: [],
  },
  {
    id: 'report-sales',
    label: { en: 'Sales report', ar: 'تقرير المبيعات' },
    menu: { en: ['Reports', 'Sales'], ar: ['التقارير', 'المبيعات'] },
    route: '#/quickreport',
    page: 'Sales report',
    description: 'Sales totals, payments and item breakdowns.',
    permission: ['report', 'read'],
    actions: [],
  },
  {
    id: 'report-purchase',
    label: { en: 'Purchase report', ar: 'تقرير المشتريات' },
    menu: { en: ['Reports', 'Purchase'], ar: ['التقارير', 'المشتريات'] },
    route: '#/receivingreport',
    page: 'Purchase report',
    description: 'Purchases and receiving totals.',
    permission: ['report', 'read'],
    actions: [],
  },
  {
    id: 'report-inventory',
    label: { en: 'Inventory report', ar: 'تقرير المخزون' },
    menu: { en: ['Reports', 'Inventory'], ar: ['التقارير', 'المخزون'] },
    route: '#/itemreport',
    page: 'Inventory report',
    description: 'Stock value, movements and product performance.',
    permission: ['report', 'read'],
    actions: [],
  },
  {
    id: 'report-people',
    label: { en: 'People report', ar: 'تقرير الأشخاص' },
    menu: { en: ['Reports', 'People'], ar: ['التقارير', 'الأشخاص'] },
    route: '#/customerreport',
    page: 'People report',
    description: 'Customer and staff activity.',
    permission: ['report', 'read'],
    actions: [],
  },
  {
    id: 'report-money',
    label: { en: 'Money report', ar: 'تقرير الأموال' },
    menu: { en: ['Reports', 'Money'], ar: ['التقارير', 'الأموال'] },
    route: '#/paymentreport',
    page: 'Money report',
    description: 'Payments, balances and cash movement.',
    permission: ['report', 'read'],
    actions: [],
  },
  {
    id: 'core-settings',
    label: { en: 'Core Settings', ar: 'الإعدادات الأساسية' },
    menu: { en: ['Manage', 'Core Settings'], ar: ['الإدارة', 'الإعدادات الأساسية'] },
    route: '#/settings/general',
    page: 'Core Settings',
    description: 'Shop identity, currency, tax and general settings.',
    permission: ['branch', 'write'],
    actions: [],
  },
  {
    id: 'branches',
    label: { en: 'Branches / Outlet', ar: 'الفروع / المنافذ' },
    menu: { en: ['Manage', 'Branches / Outlet'], ar: ['الإدارة', 'الفروع / المنافذ'] },
    route: '#/branches',
    page: 'Branches / Outlet',
    description: 'Shop branches and outlets.',
    permission: ['branch', 'read'],
    actions: [],
  },
  {
    id: 'employees',
    label: { en: 'Employees', ar: 'الموظفون' },
    menu: { en: ['Manage', 'Employees'], ar: ['الإدارة', 'الموظفون'] },
    route: '#/users',
    page: 'Employees',
    description: 'Staff accounts, roles and permissions.',
    permission: ['user', 'read'],
    actions: [],
  },
  {
    id: 'features',
    label: { en: 'Features', ar: 'الميزات' },
    menu: { en: ['Manage', 'Features'], ar: ['الإدارة', 'الميزات'] },
    route: '#/settings/modules',
    page: 'Features',
    description: 'Switches that turn optional modules on and off.',
    permission: ['branch', 'write'],
    actions: [],
  },
  {
    id: 'extensions',
    label: { en: 'Extensions', ar: 'الإضافات' },
    menu: { en: ['Manage', 'Extensions'], ar: ['الإدارة', 'الإضافات'] },
    route: '#/extensions',
    page: 'Extensions',
    description: 'Installed extensions and their pages.',
    permission: ['extensions', 'read'],
    actions: [],
  },
  {
    id: 'ai-assistant',
    label: { en: 'AI Assistant', ar: 'المساعد الذكي' },
    menu: { en: ['Manage', 'AI Assistant'], ar: ['الإدارة', 'المساعد الذكي'] },
    route: '#/ai',
    page: 'AI Assistant',
    description: 'The assistant page where the shop turns the assistant on and chats with it.',
    permission: ['branch', 'write'],
    actions: [],
  },
  {
    id: 'cash-register',
    label: { en: 'Cash Register', ar: 'ماكينة النقد' },
    menu: { en: ['Manage', 'Cash Register'], ar: ['الإدارة', 'ماكينة النقد'] },
    route: '#/settings/cashregister',
    page: 'Cash Register',
    description: 'Registers, cash drawers and till sessions.',
    permission: ['branch', 'write'],
    actions: [],
  },
  {
    id: 'workforce',
    label: { en: 'Workforce', ar: 'القوى العاملة' },
    menu: { en: ['Manage', 'Workforce'], ar: ['الإدارة', 'القوى العاملة'] },
    route: '#/settings/workforce',
    page: 'Workforce',
    description: 'Shifts, attendance and staff scheduling.',
    permission: ['branch', 'write'],
    actions: [],
  },
  {
    id: 'themes',
    label: { en: 'Themes', ar: 'السمات' },
    menu: { en: ['Manage', 'Themes'], ar: ['الإدارة', 'السمات'] },
    route: '#/settings/theme',
    page: 'Themes',
    description: 'Appearance, colours and dark mode.',
    permission: ['branch', 'write'],
    actions: [],
  },
  {
    id: 'recycle-bin',
    label: { en: 'Recycle Bin', ar: 'سلة المحذوفات' },
    menu: { en: ['Manage', 'Recycle Bin'], ar: ['الإدارة', 'سلة المحذوفات'] },
    route: '#/settings/recyclebin',
    page: 'Recycle Bin',
    description: 'Deleted records that can be restored.',
    permission: ['branch', 'write'],
    actions: [],
  },
  {
    id: 'till-pin-lock',
    label: { en: 'Till PIN Lock', ar: 'قفل نقطة البيع برقم سري' },
    menu: { en: ['Manage', 'Till PIN Lock'], ar: ['الإدارة', 'قفل نقطة البيع برقم سري'] },
    route: '#/settings/tillpin',
    page: 'Till PIN Lock',
    description: 'Locks the till between sales and unlocks it with a PIN.',
    permission: ['branch', 'write'],
    actions: [],
  },
  {
    id: 'devices-printing',
    label: { en: 'Devices & Printing', ar: 'الأجهزة والطباعة' },
    menu: { en: ['Manage', 'Devices & Printing'], ar: ['الإدارة', 'الأجهزة والطباعة'] },
    route: '#/settings/hardware',
    page: 'Devices & Printing',
    description: 'Printers, cash drawer and weighing scale for this computer.',
    permission: ['branch', 'write'],
    actions: [],
  },
  {
    id: 'app-settings',
    label: { en: 'App Settings', ar: 'إعدادات التطبيق' },
    menu: { en: ['Manage', 'App Settings'], ar: ['الإدارة', 'إعدادات التطبيق'] },
    route: '#/settings/app',
    page: 'App Settings',
    description: 'Desktop application behaviour.',
    permission: ['branch', 'write'],
    actions: [],
  },
  {
    id: 'software-updates',
    label: { en: 'Software Updates', ar: 'تحديثات البرنامج' },
    menu: { en: ['Manage', 'Software Updates'], ar: ['الإدارة', 'تحديثات البرنامج'] },
    route: '#/settings/updates',
    page: 'Software Updates',
    description: 'Check for and install Posnic updates.',
    permission: ['branch', 'write'],
    actions: [],
  },
  {
    id: 'backup-recovery',
    label: { en: 'Backup & Recovery', ar: 'النسخ الاحتياطي والاستعادة' },
    menu: { en: ['Manage', 'Backup & Recovery'], ar: ['الإدارة', 'النسخ الاحتياطي والاستعادة'] },
    route: '#/settings/backups',
    page: 'Backup & Recovery',
    description: 'Backups and restore points.',
    permission: ['branch', 'write'],
    actions: [],
  },
  {
    id: 'system-status',
    label: { en: 'System Status', ar: 'حالة النظام' },
    menu: { en: ['Manage', 'System Status'], ar: ['الإدارة', 'حالة النظام'] },
    route: '#/settings/systemstatus',
    page: 'System Status',
    description: 'Database, API, sync and device health.',
    permission: ['branch', 'write'],
    actions: [],
  },
];

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\u064B-\u0652\u0670\u0640]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'to', 'in', 'on', 'at', 'of', 'for', 'is', 'are', 'do', 'does',
  'i', 'we', 'you', 'it', 'my', 'our', 'how', 'where', 'what', 'which', 'can', 'me',
  'please', 'و', 'في', 'من', 'علي', 'الي', 'عن', 'كيف', 'اين', 'ما', 'هل', 'هو',
  'هي', 'انا',
]);

function tokens(value) {
  return normalize(value)
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

function destinationText(destination) {
  return [
    destination.label.en,
    destination.label.ar,
    destination.page,
    destination.description,
    ...(destination.aliases || []),
    ...destination.menu.en,
    ...destination.menu.ar,
    ...destination.actions.flatMap((action) => [
      action.label.en,
      action.label.ar,
      action.location,
      ...(action.aliases || []),
    ]),
  ].join(' ');
}

function actionScore(action, phrase, words) {
  const text = normalize([
    action.label.en,
    action.label.ar,
    action.location,
    ...(action.aliases || []),
  ].join(' '));
  let score = 0;
  if ((action.aliases || []).some((alias) => normalize(alias) === phrase)) score += 40;
  if ((action.aliases || []).some((alias) => normalize(alias).includes(phrase))) score += 20;
  if (words.length && words.every((word) => text.includes(word))) score += 12;
  for (const word of words) {
    if (text.includes(word)) score += 3;
  }
  return score;
}

function publicDestination(destination) {
  return {
    id: destination.id,
    label: destination.label.en,
    labelAr: destination.label.ar,
    menu: destination.menu.en,
    menuAr: destination.menu.ar,
    route: destination.route,
    page: destination.page,
    description: destination.description,
    permission: destination.permission,
    actions: destination.actions.map((action) => ({
      id: action.id,
      label: action.label.en,
      labelAr: action.label.ar,
      route: action.route,
      location: action.location,
      permission: action.permission,
    })),
  };
}

function search(query, options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(options.limit, 10)) : 5;
  const phrase = normalize(query);
  const words = tokens(query);
  if (!phrase) return [];

  const scored = [];
  for (const destination of DESTINATIONS) {
    const haystack = normalize(destinationText(destination));
    const label = normalize(`${destination.label.en} ${destination.label.ar}`);
    const page = normalize(destination.page);
    let score = 0;
    if ((destination.aliases || []).some((alias) => normalize(alias) === phrase)) score += 40;
    if ((destination.aliases || []).some((alias) => normalize(alias).includes(phrase))) score += 18;
    if (label.includes(phrase)) score += 60;
    else if (page.includes(phrase)) score += 36;
    else if (haystack.includes(phrase)) score += 18;
    for (const word of words) {
      if (normalize(destination.label.en).includes(word) || normalize(destination.label.ar).includes(word)) {
        score += 10;
      } else if (haystack.includes(word)) {
        score += 4;
      }
    }

    const rankedActions = destination.actions
      .map((action) => ({ action, score: actionScore(action, phrase, words) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.action);

    const actions = (rankedActions.length ? rankedActions : destination.actions).map((action) => ({
      id: action.id,
      label: action.label.en,
      labelAr: action.label.ar,
      route: action.route,
      location: action.location,
      permission: action.permission,
    }));

    if (score === 0 && rankedActions.length === 0) continue;
    if (rankedActions.length) score += rankedActions.length * 6;
    scored.push({
      ...publicDestination(destination),
      actions,
      score,
    });
  }

  scored.sort((left, right) => right.score - left.score || left.label.localeCompare(right.label));
  return scored.slice(0, limit).map(({ score, ...destination }) => destination);
}

function get(id) {
  const destination = DESTINATIONS.find((entry) => entry.id === id);
  return destination ? publicDestination(destination) : null;
}

function list() {
  return DESTINATIONS.map(publicDestination);
}

module.exports = {
  DESTINATIONS,
  STOP_WORDS,
  get,
  list,
  normalize,
  search,
  tokens,
};
