import express from 'express';
import pool from '../db';
import { v4 as uuidv4 } from 'uuid';
const router = express.Router();

router.post('/', async (req,res)=>{
  const { org_id, animal_type, portion_type, portion_fraction, initial_weight_kg, purchase_cost, supplier } = req.body;
  const client = await pool.connect();
  try{
    const id = uuidv4();
    await client.query(`INSERT INTO inventory_batches (id, org_id, animal_type, portion_type, portion_fraction, initial_weight_kg, purchase_cost, supplier)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, org_id, animal_type, portion_type, portion_fraction, initial_weight_kg, purchase_cost, supplier]);
    res.json({ success:true, batch_id: id });
  }catch(e){ console.error(e); res.status(500).json({error:'fail'});}finally{ client.release(); }
});

router.post('/:batchId/sections', async (req,res)=>{
  const batchId = req.params.batchId;
  const { section_type, section_weight_kg } = req.body;
  const client = await pool.connect();
  try{
    const r = await client.query('INSERT INTO batch_sections (id, batch_id, section_type, section_weight_kg) VALUES (gen_random_uuid(), $1, $2, $3) RETURNING *', [batchId, section_type, section_weight_kg]);
    res.json({ success:true, section: r.rows[0] });
  }catch(e){ console.error(e); res.status(500).json({error:'fail'});}finally{ client.release(); }
});

router.post('/:sectionId/process', async (req,res)=>{
  // section processing: outputs array [{ product_id, output_weight_kg, is_waste, is_byproduct }]
  const sectionId = req.params.sectionId;
  const outputs = req.body.outputs || [];
  const client = await pool.connect();
  try{
    await client.query('BEGIN');
    for (const o of outputs){
      await client.query(`INSERT INTO batch_outputs (id, section_id, product_id, output_weight_kg, is_waste, is_byproduct)
        VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`, [sectionId, o.product_id, o.output_weight_kg, o.is_waste || false, o.is_byproduct || false]);
      if (!o.is_waste){
        // add to product inventory
        await client.query(`UPDATE products SET available_kg = available_kg + $1 WHERE id=$2`, [o.output_weight_kg, o.product_id]);
        await client.query(`INSERT INTO inventory_transactions (id, org_id, product_id, change_kg, reason, ref_id) VALUES (gen_random_uuid(), (SELECT org_id FROM inventory_batches WHERE id=$1), $2, $3, 'batch_output', $4)`,
          [sectionId, o.product_id, o.output_weight_kg, sectionId]);
      } else {
        await client.query(`INSERT INTO inventory_transactions (id, org_id, product_id, change_kg, reason, ref_id) VALUES (gen_random_uuid(), (SELECT org_id FROM inventory_batches WHERE id=$1), NULL, $2, 'waste', $3)`,
          [sectionId, o.output_weight_kg, sectionId]);
      }
    }
    await client.query('COMMIT');
    res.json({ success:true });
  }catch(e){ await client.query('ROLLBACK'); console.error(e); res.status(500).json({error:'fail'});}finally{ client.release(); }
});

export default router;
