const mongoose = require('mongoose');
const { defineModel } = require('../db/model-registry');
const { toJSON, paginate } = require('./plugins');

// Mongoose-based Item model used by new code (sales, inventory, categories)
const itemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    creation_origin: { type: mongoose.Schema.Types.Mixed, immutable: true },
    catalogue_source_id: String,
    catalogue_shared_fingerprint: String,
    catalogue_distribution: mongoose.Schema.Types.Mixed,
    default_language: { type: String, default: '' },
    translations: {
      type: [{ _id: false, locale: String, name: String, description: String }],
      default: [],
    },
    barcode_id: String,
    sku: String,
    category_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Category' },
    category_name: { type: String, trim: true },
    supplier_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier' },
    supplier_name: { type: String, trim: true },
    branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch' },
    branch_name: { type: String, trim: true },
    quantity: { type: Number, default: 0 },
    available_quantity: { type: Number, default: 0 },
    cost_price: { type: Number, default: 0 },
    company_price: { type: Number, default: 0 },
    selling_price: { type: Number, default: 0 },
    selling_units: { type: [mongoose.Schema.Types.Mixed], default: [] },
    stock_locations: { type: [String], default: [] },
    unit: { type: String },
    discount_amount: { type: Number, default: 0 },
    discount_percentage: { type: Number, default: 0 },
    itemid: { type: String, trim: true },
    item_status: { type: String, trim: true },
    track_inventory: { type: Boolean, default: false },
    negative_stock: { type: Boolean, default: false },
    image: { type: String, trim: true },

    license: { type: mongoose.Schema.Types.ObjectId, ref: 'License' },
    available_for_sale: { type: Boolean, default: true },
    availability_revision: String,
    availability_history: [mongoose.Schema.Types.Mixed],
    is_active: { type: Boolean, default: true },

    /* Derived search index. Never shown in an API response; rebuilt by the
       migration and kept current by the item write paths. */
    search_text: { type: String, default: '', select: false },
    search_tokens: { type: [String], default: [], select: false },
    search_ngrams: { type: [String], default: [], select: false },
    search_phonetics: { type: [String], default: [], select: false },
    search_index_version: { type: Number, default: 0, select: false },
  },
  {
    collection: 'items',
    timestamps: { createdAt: 'created_date', updatedAt: 'updated_date' },
  }
);

itemSchema.plugin(toJSON);
itemSchema.plugin(paginate);

/*
 * The Item List's whitelisted sorts (price, cost, stock, recency, name) each
 * walk one of these; without them every re-sort scans the branch's whole
 * catalogue. Margin sort is computed per query and cannot use an index -
 * that one is documented as a scan in item.repository.findPage.
 */
itemSchema.index({ license: 1, branch_id: 1, selling_price: -1 });
itemSchema.index({ license: 1, branch_id: 1, company_price: -1 });
itemSchema.index({ license: 1, branch_id: 1, available_quantity: 1 });
itemSchema.index({ license: 1, branch_id: 1, updated_date: -1 });
itemSchema.index({ license: 1, branch_id: 1, name: 1 });
itemSchema.index({ license: 1, branch_id: 1, search_tokens: 1 }, { name: 'item_search_tokens' });
itemSchema.index({ license: 1, branch_id: 1, search_ngrams: 1 }, { name: 'item_search_ngrams' });
itemSchema.index(
  { license: 1, branch_id: 1, search_phonetics: 1 },
  { name: 'item_search_phonetics' }
);

const Item = defineModel('Item', itemSchema);

// Attach the legacy BaseModel-based implementation so callers can import
// both the Mongoose model and the legacy class from a single module
// (item.model.js).
// NOTE: ItemModel now primarily exists for backward compatibility. The
// authoritative implementations for all item DB operations live in
// ItemRepository. Most instance methods below are legacy-only and should
// not be used by new code.
//
// Usage examples (legacy only - new code should NOT use these directly):
//   const Item = require("../models/item.model");          // Mongoose
//   const LegacyItem = Item.LegacyItemModel;               // Legacy class alias
//   const { LegacyItemModel } = require("../models/item.model");

class ItemModel {
  static collectionName = 'items';

  static fields = {
    _id: { type: 'ObjectId', select: true, name: 'id' },
    name: { type: 'String', select: true },
    default_language: { type: 'String', select: true },
    translations: { type: 'Array', select: true },
    itemid: { type: 'String', select: true },
    barcode_id: { type: 'String', select: true },
    /*
     * The GLOBAL identifier, kept apart from barcode_id on purpose.
     *
     * barcode_id is whatever this shop prints or scans - it may be a GTIN, an
     * in-store code, or a supplier reference somebody typed. gtin is only ever
     * set when it validates (see utils/gtin.js), because a wrong GTIN is worse
     * than a missing one: it claims to be a product it is not, and anyone
     * matching against it inherits the error.
     *
     * gtin14 is the zero-padded comparison form. A UPC-A and the EAN-13 of the
     * same product differ only by a leading zero, so matching on the raw string
     * is how one product becomes two rows.
     */
    gtin: { type: 'String', select: true },
    gtin14: { type: 'String', select: true },
    image: { type: 'String', select: true },
    multi_image: { type: 'Array', select: true },
    category_id: { type: 'ObjectId', select: true },
    category_name: { type: 'String', select: true },
    supplier_id: { type: 'ObjectId', select: true },
    supplier_name: { type: 'String', select: true },
    mrp_price: { type: 'Number', select: true },
    company_price: { type: 'Number', select: true },
    selling_price: { type: 'Number', select: true },
    available_quantity: { type: 'Number', select: true },
    item_status: { type: 'String', select: true },
    description: { type: 'String', select: true },
    discount_amount: { type: 'Number', select: true },
    discount_percentage: { type: 'Number', select: true },
    unit: { type: 'String', select: true },
    unit_id: { type: 'String', select: true },
    selling_units: { type: 'Array', select: true },
    stock_locations: { type: 'Array', select: true },
    track_inventory: { type: 'Boolean', select: true },
    available_for_sale: { type: 'Boolean', select: true },
    availability_revision: { type: 'String', select: true },
    negative_stock: { type: 'Boolean', select: true },
    sort_order: { type: 'Number', select: true },
    // Alternate barcodes (V3) - lookup matches these beside barcode_id.
    barcodes: { type: 'Array', select: true },
    // Unit conversion (V3) - receiving entry assist; stock stays base units.
    purchase_unit: { type: 'String', select: true },
    conversion_factor: { type: 'Number', select: true },
    // Variant family link (V1) - the edit page's family strip reads these.
    variant_group_id: { type: 'ObjectId', select: true },
    variant_axis: { type: 'String', select: true },
    variant_value: { type: 'String', select: true },
    variant_parent_name: { type: 'String', select: true },
    /* IC0: the form wrote these long before the map knew them - any read
       projecting through this map silently dropped them. */
    items_mfg_date: { type: 'String', select: true },
    items_expiry_date: { type: 'String', select: true },
    parcel_details: { type: Object, default: undefined },
    item_weight_machine_based: { type: 'Boolean', select: true },
    modifier_group_ids: { type: 'Array', select: true },
    // IC1: deliberate ask-at-the-till pricing, set from the item form.
    open_price: { type: 'Boolean', select: true },
    // Loyverse study L2: the no-image sale-grid tile's colour and shape.
    tile_color: { type: 'String', select: true },
    tile_shape: { type: 'String', select: true },
    // Quick code (owner ask): "22 is hamam soap" - typed + Enter carts it.
    plu_code: { type: 'String', select: true },
    // Square study Q3: services - a second sellable kind, no stock.
    item_kind: { type: 'String', select: true },
    service_unit: { type: 'String', select: true },
    // Lightspeed study LS1: brand, tags, per-item reorder point.
    brand: { type: 'String', select: true },
    tags: { type: 'Array', select: true },
    reorder_point: { type: 'Number', select: true },
    branch_access: { type: 'Array', select: false },
    branch_id: { type: 'ObjectId', select: true },
    branch_name: { type: 'String', select: true },
    created_date: { type: 'Date', select: true },
    creation_origin: { type: 'Object', select: true },
    catalogue_source_id: { type: 'String', select: true },
    catalogue_distribution: { type: 'Object', select: true },
    updated_date: { type: 'Date', select: true },
    created_by: { type: 'String', select: false },
    created_by_id: { type: 'ObjectId', select: false },
    updated_by: { type: 'String', select: false },
    updated_by_id: { type: 'ObjectId', select: false },
    license: { type: 'ObjectId', select: false },
  };
}

Item.LegacyItemModel = ItemModel;

module.exports = Item;
