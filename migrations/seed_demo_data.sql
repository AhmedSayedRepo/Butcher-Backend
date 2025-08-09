-- Seed data for butcher cashier demo
INSERT INTO organizations (id, name) VALUES ('11111111-1111-1111-1111-111111111111', 'Demo Butcher') ON CONFLICT DO NOTHING;

-- Products table assumed to exist; adjust if using migrations
INSERT INTO products (id, org_id, name, price_per_kg, min_sell_kg, rounding_scheme, available_kg, active)
VALUES
  ('a1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'Ribeye', 20.00, 0.1, '0.01', 50.0, true),
  ('a2222222-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'Minced Beef', 8.50, 0.1, '0.01', 30.0, true);

-- Create an admin user (password must be hashed if using signup flow)
INSERT INTO users (id, org_id, email, name, role, password_hash)
VALUES ('u-admin-00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'admin@demo.local', 'Admin', 'superadmin', '') ON CONFLICT DO NOTHING;
