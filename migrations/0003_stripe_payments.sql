ALTER TABLE customers ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE orders ADD COLUMN payment_intent_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS orders_by_payment_intent ON orders(payment_intent_id);
