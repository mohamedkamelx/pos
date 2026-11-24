'use strict';

jest.mock('../../../src/controllers/items.controller', () => ({
  accessMobileApp: jest.fn(),
  getAll: jest.fn(),
  itemLowStockTable: jest.fn(),
  getOnlineItemsAjaxList: jest.fn(),
  onlineSalesItemsAjaxLists: jest.fn(),
  instanceItemInsert: jest.fn(),
  deleteInstant: jest.fn(),
  getByCategory: jest.fn(),
  search: jest.fn(),
  quantityCount: jest.fn(),
  getDataChanges: jest.fn(),
  itemsImport: jest.fn(),
  exportItems: jest.fn(),
  categoryItemsReportTable: jest.fn(),
  supplierItemsReportTable: jest.fn(),
  itemReportTable: jest.fn(),
  uploadItemMultiImage: jest.fn(),
  getReceivingItemsAjaxList: jest.fn(),
  getItemsByCategoryId: jest.fn(),
  itemSearchTable: jest.fn(),
  updateItemQuantity: jest.fn(),
  categoryProductDetails: jest.fn(),
  supplierProductDetails: jest.fn(),
  getCustomerSearchItemsAjaxList: jest.fn(),
  itemStockReportTable: jest.fn(),
  add: jest.fn(),
  delete: jest.fn(),
  getItemDetails: jest.fn(),
  getOne: jest.fn(),
  edit: jest.fn(),
}));

jest.mock('../../../src/middleware/auth', () => ({
  protect: jest.fn((req, res, next) => next()),
  optionalProtect: jest.fn((req, res, next) => next()),
}));
jest.mock('../../../src/middleware/items.validation', () => ({
  validateCreateItem: [],
  validateUpdateItem: [],
  /* A validator the route names and the mock does not provide is `undefined`
     handed to router.post, which throws "argument handler must be a function"
     at require time and fails the entire suite before a single test runs. */
  validateSoldOut: [],
  ensureValidItemIdParam: jest.fn((req, res, next) => next()),
}));

const router = require('../../../src/routes/items.routes');

describe('items.routes', () => {
  test('exposes key item routes', () => {
    const paths = router.stack
      .filter((layer) => layer.route)
      .map((layer) => `${Object.keys(layer.route.methods)[0]} ${layer.route.path}`);
    expect(paths).toEqual(
      expect.arrayContaining([
        'get /',
        'post /itemsImport',
        'post /exportItems',
        'post /',
        'get /:id',
        'put /:id',
      ])
    );
  });

  test('the legacy item autocomplete used by older tills stays behind auth', () => {
    const { protect } = require('../../../src/middleware/auth');
    const layer = router.stack.find(
      (l) => l.route && l.route.path === '/getOnlineItemsAjaxList' && l.route.methods.get
    );
    expect(layer).toBeDefined();
    expect(router.stack.some((l) => !l.route && l.handle === protect)).toBe(true);
  });

  test('the sale shelf is paged and stays behind auth', () => {
    const { protect } = require('../../../src/middleware/auth');
    const layer = router.stack.find(
      (l) => l.route && l.route.path === '/onlineSalesItemsAjaxLists' && l.route.methods.get
    );
    expect(layer).toBeDefined();
    expect(router.stack.some((l) => !l.route && l.handle === protect)).toBe(true);
  });
});

test('saved-item details route removes stock quantity before invoking the item editor', () => {
  const route = router.stack.find((layer) => layer.route?.path === '/:id/details').route;
  const controller = require('../../../src/controllers/items.controller');
  const req = { body: { name: 'Item', brand: 'Brand', available_quantity: 100 } };
  let index = 0;
  const next = () => {
    const layer = route.stack[index++];
    if (layer) layer.handle(req, {}, next);
  };
  next();
  expect(req.body).toEqual({ name: 'Item', brand: 'Brand' });
  expect(controller.edit).toHaveBeenCalledWith(req, {}, expect.any(Function));
});
