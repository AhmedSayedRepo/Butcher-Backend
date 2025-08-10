import express from 'express'; const router = express.Router();
router.post('/parse-order', (req,res)=>{ const { message } = req.body; // naive parser
  const items = []; (message||'').toLowerCase().split(/and|,|;/).forEach(t=>{ const m = t.match(/([0-9]*\.?[0-9]+)\s*kg\s*(.+)/); if(m) items.push({ product_name: m[2].trim(), requested_kg: parseFloat(m[1]) }); });
  res.json({ items, clarification_needed: items.length===0 });
});
export default router;
