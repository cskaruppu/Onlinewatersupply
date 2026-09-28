-- Saved addresses and tanker orders.

-- Known Coimbatore localities. Their approximate centre points only pre-fill the delivery pin;
-- the customer can refine it with their phone's location.
CREATE TABLE localities (
  id      serial PRIMARY KEY,
  name    text         NOT NULL UNIQUE,
  zone_id smallint     NOT NULL REFERENCES zones(id),
  pincode char(6)      NOT NULL CHECK (pincode ~ '^6[0-9]{5}$'),
  lat     numeric(9,6) NOT NULL,
  lng     numeric(9,6) NOT NULL
);

INSERT INTO localities (name, zone_id, pincode, lat, lng)
SELECT v.name, z.id, v.pincode, v.lat, v.lng
FROM (VALUES
  ('Saravanampatti',  'north-east', '641035', 11.0773, 76.9993),
  ('Keeranatham',     'north-east', '641035', 11.1000, 77.0000),
  ('Kalapatti',       'north-east', '641048', 11.0730, 77.0400),
  ('Peelamedu',       'north-east', '641004', 11.0287, 77.0270),
  ('Ganapathy',       'north-east', '641006', 11.0390, 76.9670),
  ('Gandhipuram',     'central',    '641012', 11.0180, 76.9660),
  ('RS Puram',        'central',    '641002', 11.0090, 76.9500),
  ('Town Hall',       'central',    '641001', 10.9950, 76.9610),
  ('Race Course',     'central',    '641018', 11.0000, 76.9780),
  ('Vadavalli',       'west',       '641041', 11.0250, 76.9030),
  ('Kavundampalayam', 'west',       '641030', 11.0460, 76.9440),
  ('Thondamuthur',    'west',       '641109', 10.9900, 76.8400),
  ('Kuniyamuthur',    'south',      '641008', 10.9640, 76.9530),
  ('Podanur',         'south',      '641023', 10.9660, 76.9990),
  ('Sundarapuram',    'south',      '641024', 10.9540, 76.9730),
  ('Madukkarai',      'south',      '641105', 10.9050, 76.9600),
  ('Singanallur',     'east',       '641005', 10.9990, 77.0320),
  ('Ondipudur',       'east',       '641016', 11.0000, 77.0600),
  ('Sowripalayam',    'east',       '641028', 11.0080, 77.0150),
  ('Uppilipalayam',   'east',       '641015', 11.0120, 77.0030)
) AS v(name, zone_code, pincode, lat, lng)
JOIN zones z ON z.code = v.zone_code;

ALTER TABLE filling_points ADD CONSTRAINT filling_points_name_key UNIQUE (name);

-- The night slot is added automatically for early-morning deliveries, not ticked by the customer.
UPDATE add_ons SET customer_selectable = false WHERE code = 'night_slot';

ALTER TABLE customer_addresses
  ADD COLUMN locality_id       integer REFERENCES localities(id),
  ADD COLUMN distance_source   text CHECK (distance_source IN ('google', 'estimate')),
  ADD COLUMN deleted_at        timestamptz;

CREATE TABLE orders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference        text        NOT NULL UNIQUE,
  user_id          uuid        NOT NULL REFERENCES users(id),
  address_id       uuid        NOT NULL REFERENCES customer_addresses(id),
  capacity_kl      smallint    NOT NULL,
  band             char(1)     NOT NULL REFERENCES price_bands(code),
  slot             text        NOT NULL CHECK (slot IN ('asap', 'evening', 'early_morning')),
  payment_method   text        NOT NULL CHECK (payment_method IN ('cash', 'upi')),
  add_ons          text[]      NOT NULL DEFAULT '{}',
  -- The price is frozen when the order is placed: later rate-card changes never affect it.
  price_lines      jsonb       NOT NULL,
  total_paise      integer     NOT NULL CHECK (total_paise > 0),
  status           text        NOT NULL DEFAULT 'requested'
                   CHECK (status IN ('requested', 'accepted', 'on_the_way', 'delivered', 'cancelled')),
  idempotency_key  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  cancelled_at     timestamptz,
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX orders_user_idx ON orders (user_id, created_at DESC);
CREATE INDEX orders_status_idx ON orders (status) WHERE status IN ('requested', 'accepted', 'on_the_way');
