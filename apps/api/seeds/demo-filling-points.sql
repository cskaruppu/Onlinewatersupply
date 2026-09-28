-- SAMPLE filling points for local development and test environments only.
-- Loaded when SEED_DEMO_DATA=true. In production, operations enters the real licensed
-- borewells and RO plants instead (see docs/platform-features.md, "Pricing").
INSERT INTO filling_points (zone_id, name, source, lat, lng, licence_no)
SELECT z.id, v.name, v.source, v.lat, v.lng, 'SAMPLE'
FROM (VALUES
  ('north-east', 'Sample RO plant, Saravanampatti',  'treated',  11.0800, 77.0010),
  ('central',    'Sample RO plant, Gandhipuram',     'treated',  11.0200, 76.9700),
  ('west',       'Sample borewell, Vadavalli',       'borewell', 11.0290, 76.9000),
  ('south',      'Sample borewell, Kuniyamuthur',    'borewell', 10.9620, 76.9560),
  ('east',       'Sample RO plant, Singanallur',     'treated',  11.0000, 77.0300)
) AS v(zone_code, name, source, lat, lng)
JOIN zones z ON z.code = v.zone_code
ON CONFLICT (name) DO NOTHING;
