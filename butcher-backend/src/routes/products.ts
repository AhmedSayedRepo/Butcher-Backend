import express from 'express';
import { products } from '../store';
const router = express.Router();

router.get('/', (req,res)=>{
  const arr = Array.from(products.values());
  res.json({ products: arr });
});

router.post('/', (req,res)=>{
  const { name, price_per_kg, available_kg } = req.body;
  const id = String(Date.now());
  products.set(id, { id, name, price_per_kg, available_kg, min_sell_kg:0.1, rounding_step:0.01 });
  res.json({ success:true, id });
});

export default router;
