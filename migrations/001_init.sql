CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS organizations ( id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, created_at timestamptz DEFAULT now() );
CREATE TABLE IF NOT EXISTS users ( id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid REFERENCES organizations(id), email text UNIQUE, name text, role text, password_hash text, created_at timestamptz DEFAULT now() );
CREATE TABLE IF NOT EXISTS products ( id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid REFERENCES organizations(id), name text NOT NULL, price_per_kg numeric(12,2), min_sell_kg numeric(10,3) DEFAULT 0.1, rounding_step numeric(10,3) DEFAULT 0.01, available_kg numeric(12,3) DEFAULT 0 );
CREATE TABLE IF NOT EXISTS inventory_batches ( id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid REFERENCES organizations(id), animal_type text, portion_type text, portion_fraction numeric, initial_weight_kg numeric );
CREATE TABLE IF NOT EXISTS batch_sections ( id uuid PRIMARY KEY DEFAULT gen_random_uuid(), batch_id uuid REFERENCES inventory_batches(id), section_type text, section_weight_kg numeric );
CREATE TABLE IF NOT EXISTS batch_outputs ( id uuid PRIMARY KEY DEFAULT gen_random_uuid(), section_id uuid REFERENCES batch_sections(id), product_id uuid REFERENCES products(id), output_weight_kg numeric, is_waste boolean DEFAULT false );
CREATE TABLE IF NOT EXISTS inventory_transactions ( id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid REFERENCES organizations(id), product_id uuid, change_kg numeric, reason text, ref_id uuid, created_at timestamptz DEFAULT now() );
CREATE TYPE IF NOT EXISTS order_status AS ENUM ('pending','confirmed','paid','preparing','ready','completed','cancelled');
CREATE TABLE IF NOT EXISTS orders ( id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid REFERENCES organizations(id), customer_name text, customer_phone text, total_amount numeric, status order_status DEFAULT 'pending', created_at timestamptz DEFAULT now() );
CREATE TABLE IF NOT EXISTS order_items ( id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid REFERENCES orders(id), product_id uuid REFERENCES products(id), weight_kg numeric, price_per_kg numeric, item_total numeric );
CREATE TABLE IF NOT EXISTS settings ( key text PRIMARY KEY, value text );
CREATE TABLE IF NOT EXISTS audit_logs ( id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid, user_id uuid, action text, payload jsonb, created_at timestamptz DEFAULT now() );
