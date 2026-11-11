function reject(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

export async function receivePurchaseOrder(db, { orderId, items, userId }) {
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0 || !Array.isArray(items) || !items.length || items.length > 250) {
    reject('Provide at least one valid purchase-order line to receive.');
  }
  const itemIds = items.map(item => Number(item.item_id));
  if (itemIds.some(itemId => !Number.isInteger(itemId) || itemId <= 0) || new Set(itemIds).size !== itemIds.length) {
    reject('Each purchase-order line can appear only once per receipt.');
  }

  return db.transaction(async () => {
    const order = await db.prepare('SELECT id,status,warehouse_id FROM purchase_orders WHERE id=?').get(id);
    if (!order) reject('Purchase order not found.', 404);
    if (order.status !== 'ordered') reject('Only ordered, not-yet-complete purchase orders can be received.');
    if ((await db.prepare('SELECT active FROM warehouses WHERE id=?').get(order.warehouse_id))?.active !== 1) {
      reject('The delivery warehouse is inactive.');
    }

    for (const entry of items) {
      const itemId = Number(entry.item_id);
      const quantity = Number(entry.quantity);
      if (!Number.isInteger(quantity) || quantity <= 0) reject('Received quantity must be a positive whole number.');
      const item = await db.prepare('SELECT id,product_id,quantity FROM purchase_order_items WHERE id=? AND purchase_order_id=?').get(itemId, id);
      if (!item) reject('A received line does not belong to this purchase order.');
      const already = await db.prepare('SELECT COALESCE(SUM(quantity),0) quantity FROM purchase_order_receipts WHERE purchase_order_item_id=?').get(itemId);
      if (quantity > item.quantity - already.quantity) reject('Received quantity exceeds the remaining quantity for an order line.');

      await db.prepare('INSERT INTO purchase_order_receipts(purchase_order_item_id,quantity,received_by) VALUES(?,?,?)').run(itemId, quantity, userId);
      await db.prepare('INSERT INTO inventory(product_id,warehouse_id,quantity) VALUES(?,?,0) ON CONFLICT(product_id,warehouse_id) DO NOTHING').run(item.product_id, order.warehouse_id);
      await db.prepare('UPDATE inventory SET quantity=quantity+?,updated_at=CURRENT_TIMESTAMP WHERE product_id=? AND warehouse_id=?').run(quantity, item.product_id, order.warehouse_id);
      await db.prepare("INSERT INTO stock_transactions(product_id,warehouse_id,type,quantity,reference,note,user_id) VALUES(?,?,'stock_in',?,?,?,?)")
        .run(item.product_id, order.warehouse_id, quantity, `PO-${id}`, 'Purchase order receipt', userId);
    }

    const remaining = (await db.prepare(`SELECT COUNT(*) n FROM purchase_order_items i
      WHERE i.purchase_order_id=? AND i.quantity>COALESCE(
        (SELECT SUM(r.quantity) FROM purchase_order_receipts r WHERE r.purchase_order_item_id=i.id),0)`)
      .get(id)).n;
    if (!remaining) await db.prepare("UPDATE purchase_orders SET status='received' WHERE id=?").run(id);
    return { ok: true, receiving_status: remaining ? 'partially_received' : 'received' };
  })();
}
