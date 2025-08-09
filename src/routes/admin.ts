import express from 'express';
import pool from '../db';
import { verify } from '../auth';
const router = express.Router();

// middleware
router.use((req,res,next)=>{
  const a = req.headers.authorization;
  if (!a) return res.status(401).json({error:'no auth'});
  const token = a.replace('Bearer ','').trim();
  const payload:any = verify(token);
  if (!payload) return res.status(401).json({error:'invalid token'});
  req['user'] = payload;
  next();
});

router.get('/users', async (req,res)=>{
  const client = await pool.connect();
  try{
    const r = await client.query('SELECT id, email, name, role, org_id, created_at FROM users');
    res.json({ users: r.rows });
  }finally{ client.release(); }
});

router.post('/branding', async (req,res)=>{
  // simple settings table upsert
  const { app_name, logo_url, default_lang } = req.body;
  const client = await pool.connect();
  try{
    await client.query(`INSERT INTO settings (key, value) VALUES ('app_name', $1)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [app_name || 'Butcher Cashier']);
    await client.query(`INSERT INTO settings (key, value) VALUES ('logo_url', $1)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [logo_url || '']);
    await client.query(`INSERT INTO settings (key, value) VALUES ('default_lang', $1)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [default_lang || 'en']);
    res.json({ success:true });
  }catch(e){ console.error(e); res.status(500).json({error:'failed'}); }finally{ client.release(); }
});

export default router;
