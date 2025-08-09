import express from 'express';
import { products } from '../store';
const router = express.Router();

/**
 * Expects:
 * { products: [ { name, quantity_kg } ] }
 */
router.post('/', (req,res)=>{
  const requested = req.body.products || [];
  const available = [];
  const unavailable = [];
  for (const r of requested){
    const match = Array.from(products.values()).find(p=>p.name.toLowerCase()===String(r.name).toLowerCase());
    if (!match) {
      unavailable.push({ name:r.name, requested_kg:r.quantity_kg, available_kg:0 });
      continue;
    }
    if (match.available_kg >= r.quantity_kg){
      available.push({ name:match.name, available_kg: match.available_kg });
    } else {
      unavailable.push({ name:match.name, requested_kg: r.quantity_kg, available_kg: match.available_kg });
    }
  }
  res.json({ available, unavailable });
});

export default router;
