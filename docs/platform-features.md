# NeerNow platform: features, security and GPS

This is the feature plan for the three portals shown in `prototype/index.html` (Customer, Tanker owner, Admin). Items marked **(MVP)** are needed for the Coimbatore launch. The rest can follow in later phases.

## What makes it different

Most tanker apps only let you book a tanker. NeerNow also shows the customer how much water actually arrived and whether it's clean:

1. **Pay for what arrives.** A flow meter on the lorry outlet records the litres delivered. The bill shows the reading, and UPI money is held until delivery is confirmed.
2. **Water quality you can see.** Each lorry shows its water source (treated/RO or borewell), its latest lab test date and a TDS reading. The driver measures TDS at the gate with a handheld meter and the reading goes on the bill.
3. **Tamper-proof delivery.** The valve seal number is recorded at the filling point, checked against a photo at the gate, and water is released only after the customer's OTP.
4. **Fair prices in summer.** Admin sets a price cap per zone, so owners cannot overcharge during shortages.
5. **Built for apartments and sites.** Weekly or daily subscriptions, bulk booking by the society, split billing across flats and a society wallet.
6. **Local first.** Tamil and English, WhatsApp ordering, and cash on delivery for customers who don't use apps.

## 1. Customer portal

| Feature | Notes |
|---|---|
| Phone OTP login **(MVP)** | No passwords. Rate-limited, and a bot check after repeated attempts |
| Saved addresses with map pin **(MVP)** | Home, site, society. The pin is used for geofencing |
| Choose tanker **(MVP)** | Capacity, source, TDS, rating, ETA, fixed price |
| Book now or schedule **(MVP)** | Time slots and recurring subscriptions |
| UPI held until delivery **(MVP)** | Razorpay/Cashfree payment is captured after the OTP. Cash on delivery also available |
| Live GPS tracking **(MVP)** | Lorry on a map, ETA, speed, last update time |
| Delivery OTP **(MVP)** | 4 digits. Water is released only after the OTP matches |
| Masked calling **(MVP)** | Customer and driver talk through a virtual number (Exotel/Knowlarity) |
| Share live trip, SOS | SOS sends the live location to the support team |
| Delivery proof | Flow meter litres, TDS at the gate, photo of the seal and the tank |
| Rating and complaints | Complaint categories: short delivery, dirty water, extra cash demanded, late |
| GST invoice | Emailed and downloadable |
| Society account | Admin flat owner, member flats, wallet, monthly statement |
| Notifications | SMS/WhatsApp at each step: accepted, filling, on the way, at the gate, delivered |

## 2. Tanker owner portal

| Feature | Notes |
|---|---|
| KYC onboarding **(MVP)** | Upload RC book, driving licence, insurance, fitness certificate (FC), permit, water source proof and lab test report. PAN/Aadhaar are stored masked |
| Fleet management **(MVP)** | Lorries, capacity, assigned driver, status |
| Online/offline switch **(MVP)** | Owners receive orders only when online |
| Order requests **(MVP)** | Accept or decline within 30 s. Declined or unanswered orders go to the next nearest lorry |
| Driver app **(MVP)** | Navigation, customer OTP entry, seal photo, meter reading, background GPS |
| Price card **(MVP)** | Per capacity, limited by the zone cap |
| Payouts **(MVP)** | Weekly UPI/bank transfer, commission shown, GST invoices |
| Document expiry alerts | Insurance/FC/permit reminders 30 and 7 days before expiry. The lorry is suspended automatically once a document expires |
| Performance | Acceptance rate, on-time rate, ratings, complaints |
| Service areas | Zones or pincodes the owner serves |

## 3. Admin portal

| Feature | Notes |
|---|---|
| Live operations map **(MVP)** | Every lorry by status: available, on trip, alert |
| Owner verification queue **(MVP)** | Check each document. A lorry can be approved only when every document passes |
| Orders and refunds **(MVP)** | Search, reassign, cancel, refund |
| Complaints desk **(MVP)** | Set a response time per complaint type. Refunds adjust the owner's payout automatically |
| Zone pricing and caps **(MVP)** | North-East, Central, West, South zones |
| Safety and fraud alerts | See the alert rules below |
| Roles | Super admin, operations, support, finance. Each role sees only what it needs |
| Audit log | Every admin action is recorded with time, user and IP address, and can't be edited |
| Reports | Orders, revenue, arrival times, busiest areas, summer demand |
| Promotions | Coupons and first-order discounts |

## GPS tracking design

- **Source.** The driver app sends location every 10 s during a trip and every 60 s when idle. For larger fleets, a hardware GPS device (AIS-140 type) can be added as a backup that keeps working if the driver's phone dies.
- **Transport.** WebSocket (Socket.IO) from the driver app to the server, then to the customer and admin screens. Positions are stored in PostgreSQL + PostGIS.
- **Geofences.** A filling-point geofence confirms the lorry filled at an approved source. A 100 m geofence around the customer's address allows the OTP step only when the lorry is actually there.
- **ETA.** Road distance from Google Maps or Mappls (MapmyIndia) APIs, recalculated every minute.
- **Alert rules:**
  - GPS silent for more than 5 min during a trip → critical
  - More than 1 km off the planned route, or stopped for more than 8 min → warning
  - Delivery attempted outside the customer geofence → blocked
  - 3 wrong OTP attempts → delivery paused and the admin alerted
  - Flow meter reading more than 5% below the capacity paid for → complaint auto-opened
  - Speed above 60 km/h inside the city → warning to the owner
- **Privacy.** Customers see the lorry only during their own trip. Location history is kept for 90 days, then deleted.

## Security checklist

**Authentication and access**
- OTP login for customers. OTP + 4-digit PIN for owners. Admins use 2FA (authenticator app) and log in from an allowed IP list or VPN.
- Short-lived access tokens (15 min) with refresh tokens in HttpOnly, Secure, SameSite cookies.
- Role-based access control checked on the server for every API call, not only hidden in the UI.
- Lock the account after 5 failed OTPs. Rate limits per phone number and per IP. CAPTCHA after repeated failures.
- Alerts for logins from a new device or location. Admins can see active sessions and log them out.

**Data protection**
- HTTPS everywhere (TLS 1.2+), HSTS.
- Database and backups encrypted at rest. KYC files kept in private object storage and opened only through short-lived signed URLs.
- Phone numbers masked in the UI. PAN/Aadhaar stored masked, with the full value never shown.
- Follow India's DPDP Act 2023: consent at sign-up, a privacy policy, and data deletion on request.

**Application security**
- Protection against the OWASP Top 10: parameterised queries, input validation, output escaping, CSRF tokens, and a strict Content-Security-Policy.
- Card and UPI details never touch our servers (the payment gateway handles them). Payment webhooks are verified by their signature.
- Uploads are limited by file type and size and scanned for malware.
- A web application firewall and DDoS protection (Cloudflare).
- Secrets live in a vault or environment manager, never in code. Dependencies are scanned in CI.

**Operations**
- Daily encrypted backups with a monthly restore test.
- Centralised logs, uptime monitoring, and alerts for error spikes.
- An audit log of every admin action that can't be edited.
- A penetration test before launch.

## Suggested tech stack

| Part | Choice |
|---|---|
| Customer and admin web | Next.js (React) + TypeScript |
| Owner/driver mobile app | React Native or Flutter (background GPS, camera, offline queue) |
| API | Node.js (NestJS) or Django |
| Database | PostgreSQL + PostGIS, Redis for live locations and rate limits |
| Real-time | Socket.IO / WebSocket |
| Maps | Google Maps Platform or Mappls |
| Payments | Razorpay or Cashfree (UPI, payment on hold/capture) |
| SMS/OTP/WhatsApp | MSG91 or Gupshup |
| Masked calls | Exotel |
| Hosting | AWS Mumbai region or DigitalOcean Bangalore, with Cloudflare in front |

## Suggested build order

1. **Weeks 1–3:** login, customer booking, owner KYC, admin verification queue, payments.
2. **Weeks 4–6:** driver app with GPS, live tracking, OTP delivery, masked calls, payouts.
3. **Weeks 7–8:** alerts, complaints desk, zone price caps, security hardening, penetration test, then the Saravanampatti pilot.
4. **After launch:** flow meter and TDS proof, subscriptions and society accounts, Tamil UI, WhatsApp ordering.
