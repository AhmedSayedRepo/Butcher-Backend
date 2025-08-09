import express from 'express';
import { orders, products } from '../store';
import { v4 as uuidv4 } from 'uuid';
const router = express.Router();

router.get('/', (req,res)=>{
  res.json({ orders: Array.from(orders.values()) });
});

router.post('/', (req,res)=>{
  const { customer_name, customer_phone, items } = req.body;
  if (!items || items.length===0) return res.status(400).json({ error:'no items' });
  let total = 0;
  const processed = [];
  for (const it of items){
    const match = Array.from(products.values()).find(p=>p.name.toLowerCase()===String(it.name).toLowerCase());
    if (!match) return res.status(400).json({ error:`product ${it.name} not found` });
    const qty = Number(it.quantity_kg) || 0;
    const rounded = Math.max(match.min_sell_kg, Math.ceil(qty / match.rounding_step) * match.rounding_step);
    const itemTotal = Number((rounded * match.price_per_kg).toFixed(2));
    if (match.available_kg < rounded) return res.status(400).json({ error:`insufficient stock for ${match.name}` });
    // reserve (simple)
    match.available_kg = Number((match.available_kg - rounded).toFixed(3));
    processed.push({ product_id: match.id, name: match.name, weight_kg: rounded, price_per_kg: match.price_per_kg, item_total: itemTotal });
    total += itemTotal;
  }
  const id = uuidv4();
  const order = { id, customer_name, customer_phone, total_amount: Number(total.toFixed(2)), created_at: new Date().toISOString(), items: processed };
  orders.set(id, order);
  res.json({ success:true, order });
});

export default router;
