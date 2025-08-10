import express from 'express'; const router = express.Router();
router.post('/', (req,res)=>{ res.json({ success:true, batch_id: 'demo-batch-id' }); });
export default router;
