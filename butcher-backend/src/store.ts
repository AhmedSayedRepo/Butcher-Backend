import { v4 as uuidv4 } from 'uuid';

type Product = {
  id: string, name: string, price_per_kg: number, available_kg: number, min_sell_kg:number, rounding_step:number
}
type Order = { id:string, customer_name:string, customer_phone?:string, total_amount:number, created_at:string, items:any[] }

const products = new Map<string, Product>();
const orders = new Map<string, Order>();

// seed sample products
function seed(){
  const p1 = { id: uuidv4(), name: 'Ribeye', price_per_kg: 20.00, available_kg: 50.0, min_sell_kg:0.1, rounding_step:0.01 };
  const p2 = { id: uuidv4(), name: 'Minced Beef', price_per_kg: 8.50, available_kg: 30.0, min_sell_kg:0.1, rounding_step:0.01 };
  products.set(p1.id, p1);
  products.set(p2.id, p2);
}
seed();

export { products, orders, Product, Order };
