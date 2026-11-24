const { ObjectId } = require('mongodb');

/**
 * PHP: returnReceivingOrder()
 * Process return of receiving items
 * @param {Object} data - Return data including id, items, items_return
 * @returns {Promise<Object>}
 */
async function returnReceivingOrder(data) {
  try {
    const BaseModel = require('./base.model');

    if (!data || !data.id) {
      return {
        status: false,
        data: null,
        message: 'Return receiving value is null',
      };
    }

    const baseModel = new BaseModel('receivings');
    const collection = await baseModel.getCollection('receivings');
    const itemsCollection = await baseModel.getCollection('items');

    const license = BaseModel.license;
    const loggedUser = BaseModel.loggedUser;
    const loggedUserName = BaseModel.loggedUserName || '';
    const currentBranch = BaseModel.currentBranch;
    const currentBranchName = BaseModel.currentBranchName || '';

    const receivingId = new ObjectId(data.id);
    const returnItems = data.items_return || [];
    const itemsReturn = [];

    // Get branch to check stock_management setting (PHP line 562)
    const branchesCollection = await baseModel.getCollection('branches');
    const branchDoc = await branchesCollection.findOne({
      _id: new ObjectId(currentBranch),
    });

    const stockManagement = branchDoc?.stock_management === true;
    const stockLogStatus = branchDoc?.stock_management_log !== false;

    console.log('[RETURN RECEIVING DEBUG] Stock log context:', {
      stockManagement: stockManagement,
      stockLogStatus: stockLogStatus,
      returnItemCount: returnItems.length,
    });

    // Process each return item
    for (const item of returnItems) {
      const returnPrefixId =
        'RFP' +
        new Date().toISOString().slice(0, 10).replace(/-/g, '') +
        Math.floor(Math.random() * 10000);

      const itemDoc = await itemsCollection.findOne({
        _id: new ObjectId(item.item_id),
        license: new ObjectId(license),
      });

      if (!itemDoc) continue;

      // Update or remove item from receiving based on remaining quantity
      if (parseFloat(item.item_quantity) > 0) {
        await collection.updateOne(
          { _id: receivingId, 'items.item_id': item.item_id, license: new ObjectId(license) },
          {
            $set: {
              'items.$.item_quantity': parseFloat(item.item_quantity),
              'items.$.total_amount': parseFloat(item.total_amount),
            },
          }
        );
      } else {
        await collection.updateOne(
          { _id: receivingId, 'items.item_id': item.item_id, license: new ObjectId(license) },
          { $pull: { items: { item_id: item.item_id } } }
        );
      }

      // Update inventory - reduce quantity
      const returnQuantity = parseFloat(item.return_quantity || 0);

      console.log('[RETURN RECEIVING DEBUG] Item check:', {
        item_id: item.item_id,
        track_inventory: itemDoc?.track_inventory,
        track_inventory_type: typeof itemDoc?.track_inventory,
      });

      if (itemDoc.track_inventory === true || itemDoc.track_inventory === 'true') {
        const openingBalance = parseFloat(itemDoc.available_quantity || 0);
        const newQuantity = openingBalance - returnQuantity;

        // Create stock log for RETURN Receiving (PHP line 562-564)
        // Only if stock_management is enabled
        if (stockManagement) {
          console.log('[RETURN RECEIVING DEBUG] Creating stock log for item:', item.item_id);

          const stockLogData = {
            stocklog: stockLogStatus,
            branch_id: new ObjectId(currentBranch),
            view_item_id: new ObjectId(item.item_id),
            item_barcode_id: itemDoc.barcode_id || '',
            item_name: item.item_name || itemDoc.name || '',
            item_quantity: returnQuantity,
            process: 'Return Receiving',
            reference: data.id,
            opening_balance: openingBalance,
            closing_balance: newQuantity,
            count: '-' + returnQuantity,
            date: new Date(),
            action: 'Subtract',
            changed_by_userid: new ObjectId(loggedUser),
            changed_by: loggedUserName,
            license: new ObjectId(license),
            created_date: new Date(),
            updated_date: new Date(),
          };

          const stockLogsCollection = await baseModel.getCollection('stocklogs');
          await stockLogsCollection.insertOne(stockLogData);
          console.log('[RETURN RECEIVING] Stock log created successfully');
        } else {
          console.log('[RETURN RECEIVING DEBUG] Stock management disabled, skipping stock log');
        }

        await itemsCollection.updateOne(
          { _id: new ObjectId(item.item_id), license: new ObjectId(license) },
          { $set: { available_quantity: newQuantity } }
        );
      }

      itemsReturn.push({
        item_name: item.item_name,
        item_sku: itemDoc.itemid,
        item_price: parseFloat(itemDoc.company_price || 0),
        item_quantity: parseFloat(returnQuantity),
        item_unit: item.item_unit || 'qty',
        item_id: item.item_id,
        total_amount: parseFloat(item.return_total_amount || 0),
        return_id: returnPrefixId,
        return_date: new Date(),
      });
    }

    // Create return record
    const returnObjId = new ObjectId();
    const itemsReturnData = {
      returnArray: {
        returnObjId: returnObjId,
        returnId:
          'RFP' +
          new Date().toISOString().slice(0, 10).replace(/-/g, '') +
          Math.floor(Math.random() * 10000),
        returnDate: new Date(),
        returnValue: itemsReturn,
      },
    };

    await collection.updateOne(
      { _id: receivingId, license: new ObjectId(license) },
      { $push: { items_return: itemsReturnData } }
    );

    // Recalculate totals
    const receivingDoc = await collection.findOne({
      _id: receivingId,
      license: new ObjectId(license),
    });

    let receivingTotalAmount = 0;
    let receivingSubtotalAmount = 0;

    for (const item of receivingDoc.items || []) {
      receivingTotalAmount += parseFloat(item.total_amount || 0);
      const itemQuantity = parseFloat(item.item_quantity || 0);
      const itemAmount = parseFloat(item.item_price || 0) * itemQuantity;
      receivingSubtotalAmount += itemAmount;
    }

    let returnTotalAmount = 0;
    let returnSubtotalAmount = 0;

    for (const returnRecord of receivingDoc.items_return || []) {
      for (const item of returnRecord.returnArray?.returnValue || []) {
        returnTotalAmount += parseFloat(item.total_amount || 0);
        const itemQuantity = parseFloat(item.item_quantity || 0);
        const itemAmount = parseFloat(item.item_price || 0) * itemQuantity;
        returnSubtotalAmount += itemAmount;
      }
    }

    const updateData = {
      receiving_status: receivingTotalAmount === 0 ? 'FullReturn' : 'PartialReturn',
      items_subtotal: receivingSubtotalAmount,
      items_total: receivingTotalAmount,
      items_return_subtotal: returnSubtotalAmount,
      items_return_total: returnTotalAmount,
      updated_date: new Date(),
    };

    await collection.updateOne({ _id: receivingId }, { $set: updateData });

    return {
      status: true,
      data: {
        print: false,
        receiving_id: returnObjId.toString(),
      },
      message: 'Return receiving updated successfully',
    };
  } catch (error) {
    console.error('Error in returnReceivingOrder:', error);
    return {
      status: false,
      data: null,
      message: error.message || 'Failed to process return receiving',
    };
  }
}

module.exports = { returnReceivingOrder };
