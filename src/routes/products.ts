import express from 'express'; import pool from '../db'; const router = express.Router();
router.get('/', async (req:any,res)=>{ const client = await pool.connect(); try{ const r = await client.query('SELECT * FROM products LIMIT 100'); res.json({ products: r.rows }); }finally{ client.release(); } });
export default router;
