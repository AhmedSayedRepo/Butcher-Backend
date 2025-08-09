import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import dotenv from 'dotenv';
import ordersRouter from './routes/orders';
import productsRouter from './routes/products';
import availabilityRouter from './routes/availability';
import authRouter from './routes/auth';
import adminRouter from './routes/admin';
import batchesRouter from './routes/batches';
import integrationsRouter from './routes/integrations';

dotenv.config();
const app = express();
app.use(cors());
app.use(bodyParser.json());

app.use('/api/auth', authRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/products', productsRouter);
app.use('/api/check-availability', availabilityRouter);
app.use('/api/admin', adminRouter);
app.use('/api/batches', batchesRouter);
app.use('/api/integrations', integrationsRouter);

app.get('/', (req,res)=>res.json({status:'ok'}));
const port = process.env.PORT || 4000;
app.listen(port, ()=>console.log('Backend running on', port));
