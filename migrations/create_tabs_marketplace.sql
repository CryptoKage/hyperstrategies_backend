-- migrations/create_tabs_marketplace.sql

CREATE TABLE IF NOT EXISTS tabs (
  tab_id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  owner_id INTEGER REFERENCES users(user_id),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tab_listings (
  listing_id SERIAL PRIMARY KEY,
  tab_id INTEGER REFERENCES tabs(tab_id) ON DELETE CASCADE,
  seller_id INTEGER REFERENCES users(user_id),
  buyer_id INTEGER REFERENCES users(user_id),
  price NUMERIC(20,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMP DEFAULT NOW(),
  sold_at TIMESTAMP
);
