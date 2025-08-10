import express from 'express'; import pool from '../db'; const router = express.Router();
router.get('/', async (req,res)=>{ const client = await pool.connect(); try{ const r = await client.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 50'); res.json({ orders: r.rows }); }finally{ client.release(); } });
export default router;
