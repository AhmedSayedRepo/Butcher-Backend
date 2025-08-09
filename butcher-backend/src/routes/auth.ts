import express from 'express';
import pool from '../db';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { sign } from '../auth';

const router = express.Router();

router.post('/signup', async (req,res)=>{
  const { email, name, password, role='cashier', org_name } = req.body;
  if (!email || !password) return res.status(400).json({error:'email/password required'});
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // create org if provided
    let orgId = null;
    if (org_name) {
      const r = await client.query('INSERT INTO organizations (name) VALUES ($1) RETURNING id', [org_name]);
      orgId = r.rows[0].id;
    }
    const hashed = await bcrypt.hash(password, 10);
    const userId = uuidv4();
    await client.query('INSERT INTO users (id, org_id, email, name, role, password_hash) VALUES ($1,$2,$3,$4,$5,$6)',
      [userId, orgId, email, name, role, hashed]);
    await client.query('COMMIT');
    const token = sign({id:userId, role});
    res.json({ success:true, token });
  }catch(err){
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'signup failed' });
  }finally{ client.release(); }
});

router.post('/login', async (req,res)=>{
  const { email, password } = req.body;
  const client = await pool.connect();
  try{
    const r = await client.query('SELECT id, password_hash, role FROM users WHERE email=$1',[email]);
    if (r.rowCount===0) return res.status(400).json({ error:'invalid credentials' });
    const u = r.rows[0];
    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) return res.status(400).json({ error:'invalid credentials' });
    const token = sign({id:u.id, role:u.role});
    res.json({ success:true, token });
  }catch(e){ console.error(e); res.status(500).json({error:'login failed'}) }finally{ client.release(); }
});

export default router;
