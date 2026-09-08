# Movezy — operational designs (September 2026)

Reference for the client on how the platform handles document expiry,
driver dispatch, presence, number privacy and GST.

## 1. Document expiry (driver licence, RC, insurance, PUC)

**What is tracked.** Each vehicle stores `rcExpiryDate`, `insuranceExpiryDate`
and `pucExpiryDate` (entered by the partner when registering the vehicle, or
by an admin in Document Compliance). The driver's licence expiry lives on the
KYC record. Vehicles or licences with no date on file are not tracked.

**Reminders.** A scheduled job (`document-expiry`, runs nightly) computes the
days remaining for every tracked document and sends the partner a notification
at 30, 15 and 7 days before expiry. Each reminder is recorded against the
document *and its expiry date* (`expiryReminders` / `licenceExpiryReminders`),
so a reminder is sent exactly once per stage and a renewed date restarts the
cycle automatically.

**Enforcement.** On the day a document expires the vehicle is put on a
dispatch block (`dispatchBlock`), or — for the licence — the driver is
blocked (`documentBlock`) and forced offline. Blocked vehicles/drivers do not
receive bookings; the partner sees "Paused — documents expired" on the vehicle.

**Lifting the block.** An admin records the renewed date in Safety & Compliance
→ Document Compliance (or the partner re-uploads). The block is recomputed
immediately and dispatch resumes.

**Caching.** The admin summary ("what expires in the next N days") is cached in
Redis for 15 minutes (`compliance:expiry-summary:<days>`) and invalidated by the
nightly job and by any date edit, so the page is fast without going stale.
Redis is optional: without it the summary is computed live.

## 2. Dispatch — nearest driver first

1. When a booking is created, eligible drivers within 5 km are ordered by
   distance and queued (online, approved, active vehicle of the booked
   category, no active trip, no pending offer, training complete).
2. The nearest driver is rung for `DISPATCH_OFFER_SECONDS` (default 30,
   Settings → Dispatch & calling). Their app rings and shows the offer.
3. Decline, timeout, or going offline moves the offer to the next driver at
   once; the previous driver's screen closes with the reason.
4. When the queue is exhausted the radius widens 5 → 8 → 11 → 15 km. Drivers
   who declined a booking are never rung again for it.
5. State is kept in Redis for speed and in `DispatchOffer` rows for the
   record; a 30-second sweep and a stalled-search retry (10 minutes) make the
   process survive restarts. `DISPATCH_PARALLEL_OFFERS` (default 1) can ring
   the N nearest drivers at once for operators who prefer a small race.

The vehicle category is enforced on every accept, and the legacy vehicle
routes can no longer change a vehicle's type or activation.

## 3. Presence — staying online with the phone locked

"Online" is heartbeat-based. A driver stays online while any of these arrives
within 3 minutes (`DRIVER_OFFLINE_GRACE_MS`): a socket connection, a location
update, or `POST /driver/app/heartbeat`. The driver app runs a foreground
service ("Movezy — you are online") that posts a heartbeat with the current
position every minute even when the screen is locked, asks for the battery-
optimisation exemption once, and reconnects its socket on resume. A presence
sweep runs every 30 seconds and flips a driver offline only after the grace
window with no socket connected. Going offline on purpose (toggle, logout) is
immediate.

## 4. Number privacy (masked / proxy calling)

Contact numbers in app payloads are masked (`XXXXXX1234`) whenever masking is
active; the Call buttons in both apps call the server instead
(`POST /bookings/:id/call`, `POST /driver/app/bookings/:id/call`). The server
bridges the call through Twilio Programmable Voice: it rings the person who
tapped Call, then connects the other party with the Movezy number as caller
ID, so both handsets only see the Movezy number. Every attempt is logged
(`CallLog`) and rate-limited (6 per party per booking per 10 minutes).

Configuration: `CALL_MASKING_PROVIDER=twilio`, the existing
`TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN`, and a voice-capable
`TWILIO_VOICE_NUMBER`. Until the voice number is provisioned the server falls
back to handing the app the real number (Settings → "Allow direct dialling
when the bridge is unavailable"; turn it off to make calling unavailable
rather than reveal numbers). "Hide phone numbers in the apps" masks payloads
even before the provider is configured.

## 5. GST split (CGST + SGST vs IGST)

Every trip is taxed at the platform rate (`gstPercentage` in Commission &
Charges). The split is decided per booking by `tax.service`:

- **Place of supply**: the customer's registered state (first two digits of
  their GSTIN) when they have one; otherwise the state of the pickup address
  (sent by the app, or reverse-geocoded and cached).
- **Supplier state**: the first two digits of `COMPANY_GSTIN`
  (Commission & Charges → Tax identity), or `COMPANY_STATE`.
- Same state → CGST + SGST at half the rate each; different states → IGST;
  either side unknown → a single "GST" line, never a guessed split.

State codes and names are **data**: the `TaxJurisdiction` collection (seeded
with the 37 GST codes, admin-editable aliases) — no state or rate is hard-coded
in the workflow. The split is stored on the booking (`taxBreakdown`), refreshed
whenever the fare changes (added stop, waiting charge), copied to the invoice,
printed on the PDF with the place of supply, and shown on the admin order
detail.
