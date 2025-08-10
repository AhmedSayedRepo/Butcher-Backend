import express from 'express'; const router = express.Router();
router.post('/', (req,res)=>{ const requested = req.body.products || []; // simplistic demo response
  const available = requested.map(p=> ({ name:p.name, available_kg: Math.random()*10+1 }));
  res.json({ available, unavailable: [] });
});
export default router;
