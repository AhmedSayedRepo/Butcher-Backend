import express from 'express';
import pool from '../db';
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();
const router = express.Router();

// OpenAI parse endpoint (server-side call to model)
router.post('/parse-order', async (req,res)=>{
  const { message, products_list } = req.body;
  try{
    const prompt = `You are an ordering assistant. Extract JSON items with name and quantity_kg from the message. Message: ${message}`;
    const r = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini',
      messages: [{ role:'system', content:'You are an ordering assistant.' }, { role:'user', content: prompt }],
      max_tokens: 400
    }, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } });
    const text = r.data.choices?.[0]?.message?.content || '';
    res.json({ parsed_text: text });
  }catch(e){ console.error(e.response?.data || e); res.status(500).json({error:'openai failed'}) }
});

// Twilio send message (simple)
router.post('/send-whatsapp', async (req,res)=>{
  const { to, body } = req.body;
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_NUMBER;
  try{
    const r = await axios.post(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, new URLSearchParams({
      From: from, To: to, Body: body
    }).toString(), { headers: { 'Content-Type':'application/x-www-form-urlencoded' }, auth: { username: accountSid, password: authToken } });
    res.json({ success:true, sid: r.data.sid });
  }catch(e){ console.error(e.response?.data || e); res.status(500).json({error:'twilio failed'}) }
});

// Stripe payment link creation
router.post('/create-payment-link', async (req,res)=>{
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  const { amount_cents, currency='usd', metadata } = req.body;
  try{
    const product = await stripe.products.create({ name: metadata?.description || 'Order Payment' });
    const price = await stripe.prices.create({ product: product.id, unit_amount: amount_cents, currency });
    const link = await stripe.paymentLinks.create({ line_items: [{ price: price.id, quantity: 1 }], metadata });
    res.json({ url: link.url });
  }catch(e){ console.error(e); res.status(500).json({error:'stripe failed'}) }
});

export default router;
