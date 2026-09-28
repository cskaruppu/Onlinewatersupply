-- Pricing by zone and distance band.
--
-- A customer's price depends on their saved address, never on the route a lorry drives:
--   price = rate_card[capacity, band] + add-ons that apply + platform fee
-- The band comes from the ROAD distance between the address and the nearest approved
-- filling point, measured once when the address is saved (Google Maps / Mappls).
-- All money is stored in paise (1 rupee = 100 paise) to avoid rounding errors.

CREATE TABLE zones (
  id        smallserial PRIMARY KEY,
  code      text    NOT NULL UNIQUE,
  name      text    NOT NULL,
  areas     text[]  NOT NULL DEFAULT '{}',
  is_active boolean NOT NULL DEFAULT true
);

-- Licensed borewells / RO plants where lorries fill. Distances are measured from these.
CREATE TABLE filling_points (
  id         serial PRIMARY KEY,
  zone_id    smallint     NOT NULL REFERENCES zones(id),
  name       text         NOT NULL,
  source     text         NOT NULL CHECK (source IN ('treated', 'borewell')),
  lat        numeric(9,6) NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng        numeric(9,6) NOT NULL CHECK (lng BETWEEN -180 AND 180),
  licence_no text,
  is_active  boolean      NOT NULL DEFAULT true
);

-- Distance bands. A band covers min_km < distance <= max_km (band A also includes 0).
CREATE TABLE price_bands (
  code   char(1)      PRIMARY KEY,
  label  text         NOT NULL,
  min_km numeric(5,1) NOT NULL,
  max_km numeric(5,1) NOT NULL,
  CHECK (min_km >= 0 AND max_km > min_km)
);

-- Platform price per capacity and band, plus the cap an owner's own price may not exceed.
CREATE TABLE rate_card (
  capacity_kl smallint    NOT NULL CHECK (capacity_kl > 0),
  band        char(1)     NOT NULL REFERENCES price_bands(code),
  price_paise integer     NOT NULL CHECK (price_paise > 0),
  cap_paise   integer     NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (capacity_kl, band),
  CHECK (price_paise <= cap_paise)
);

-- Extra charges for things the customer controls or that are known before booking.
CREATE TABLE add_ons (
  code        text    PRIMARY KEY,
  label       text    NOT NULL,
  price_paise integer NOT NULL CHECK (price_paise >= 0),
  unit        text    NOT NULL CHECK (unit IN ('per_order', 'per_15_min')),
  customer_selectable boolean NOT NULL DEFAULT true
);

-- Saved delivery addresses with the band worked out once, at save time.
CREATE TABLE customer_addresses (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label               text         NOT NULL,
  address_enc         text         NOT NULL,             -- encrypted, like phone numbers
  lat                 numeric(9,6) NOT NULL,
  lng                 numeric(9,6) NOT NULL,
  zone_id             smallint     REFERENCES zones(id),
  filling_point_id    integer      REFERENCES filling_points(id),
  road_km             numeric(5,1) CHECK (road_km >= 0),
  band                char(1)      REFERENCES price_bands(code),  -- NULL: outside served area, quoted by operations
  hill_road           boolean      NOT NULL DEFAULT false,
  distance_checked_at timestamptz,
  created_at          timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX customer_addresses_user_idx ON customer_addresses (user_id);

-- Starting values for the Coimbatore pilot. Operations can change them in the admin portal.
INSERT INTO price_bands (code, label, min_km, max_km) VALUES
  ('A', 'Up to 5 km', 0, 5),
  ('B', '5 to 10 km', 5, 10),
  ('C', '10 to 15 km', 10, 15);

INSERT INTO zones (code, name, areas) VALUES
  ('north-east', 'North-East', ARRAY['Saravanampatti', 'Kalapatti', 'Peelamedu', 'Ganapathy', 'Keeranatham']),
  ('central',    'Central',    ARRAY['Gandhipuram', 'RS Puram', 'Town Hall', 'Race Course']),
  ('west',       'West',       ARRAY['Vadavalli', 'Thondamuthur', 'Maruthamalai Road', 'Kavundampalayam']),
  ('south',      'South',      ARRAY['Kuniyamuthur', 'Podanur', 'Sundarapuram', 'Madukkarai']),
  ('east',       'East',       ARRAY['Singanallur', 'Ondipudur', 'Sowripalayam', 'Uppilipalayam']);

-- Prices in paise. Caps are about 20% above the price.
INSERT INTO rate_card (capacity_kl, band, price_paise, cap_paise) VALUES
  (3,  'A',  48000,  60000), (3,  'B',  53000,  65000), (3,  'C',  60000,  72000),
  (6,  'A',  75000,  95000), (6,  'B',  85000, 105000), (6,  'C',  95000, 115000),
  (9,  'A', 110000, 135000), (9,  'B', 123000, 150000), (9,  'C', 140000, 170000),
  (12, 'A', 140000, 170000), (12, 'B', 155000, 190000), (12, 'C', 175000, 210000),
  (24, 'A', 250000, 300000), (24, 'B', 275000, 330000), (24, 'C', 305000, 370000);

INSERT INTO add_ons (code, label, price_paise, unit, customer_selectable) VALUES
  ('overhead_pumping', 'Pump to overhead tank',            15000, 'per_order',  true),
  ('long_hose',        'Hose longer than 30 m',            10000, 'per_order',  true),
  ('night_slot',       'Night or early-morning delivery',  15000, 'per_order',  true),
  ('hill_road',        'Hill road access',                 20000, 'per_order',  false),
  ('waiting',          'Waiting at the gate beyond 15 min', 10000, 'per_15_min', false);
