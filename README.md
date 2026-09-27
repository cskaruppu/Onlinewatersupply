# Online Water Supply

A portal, launching first in Coimbatore, that connects households, apartments and sites with nearby water tanker owners, so water can be ordered and delivered quickly.

## Prototype

`prototype/index.html` is a clickable, single-file prototype with three portals (sample data, no backend). Open it in any browser and switch portals at the top, or go straight to one with `#customer`, `#owner` or `#admin`.

- **Customer:** choose a tanker by capacity, water source and TDS; book with UPI held until delivery; live GPS tracking; delivery OTP; masked driver calls, trip sharing and SOS; flow meter and photo proof; rating, invoice and complaints.
- **Tanker owner:** accept or decline order requests, fleet with GPS and document-expiry status, price card limited by zone caps, weekly payouts.
- **Admin:** live fleet map, safety and fraud alerts, owner verification queue, complaints with refunds, security status, audit log.

See `docs/platform-features.md` for the full feature, GPS and security plan.

## Launch city: Coimbatore

The prototype uses Coimbatore sample data: a Saravanampatti address, local RTO lorry numbers (TN 37 / 38 / 66 / 99), and service areas across the city. See `docs/coimbatore-launch.md` for the launch plan.
