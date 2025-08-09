-- Users, settings, batches, sections, outputs, inventory transactions
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  org_id uuid REFERENCES organizations(id),
  email text UNIQUE,
  name text,
  role text,
  password_hash text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  key text PRIMARY KEY,
  value text
);

CREATE TABLE IF NOT EXISTS inventory_batches (
  id uuid PRIMARY KEY,
  org_id uuid REFERENCES organizations(id),
  animal_type text,
  portion_type text,
  portion_fraction numeric,
  initial_weight_kg numeric,
  purchase_cost numeric,
  supplier text,
  received_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS batch_sections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid REFERENCES inventory_batches(id),
  section_type text,
  section_weight_kg numeric
);

CREATE TABLE IF NOT EXISTS batch_outputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id uuid REFERENCES batch_sections(id),
  product_id uuid REFERENCES products(id),
  output_weight_kg numeric,
  is_waste boolean DEFAULT false,
  is_byproduct boolean DEFAULT false
);

CREATE TABLE IF NOT EXISTS inventory_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES organizations(id),
  product_id uuid,
  change_kg numeric,
  reason text,
  ref_id uuid,
  created_at timestamptz DEFAULT now()
);
