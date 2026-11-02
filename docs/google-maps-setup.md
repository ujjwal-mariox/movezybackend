# Google Maps setup for Movezy

Movezy uses Google for maps:
- the map on screen in both apps
- address search and "what's at this pin"
- road routes and distance, which the fares use
- live ETA

All of it runs in the **existing Firebase project `movezy-df666`**, which is also a Google Cloud project, so no new account is needed. Only the current Google APIs are used. Distance Matrix, Directions and Places (legacy) can't be enabled on projects created after 1 March 2025.

Everything below is in **console.cloud.google.com**, signed in with the Movezy Google account. First select the project **movezy-df666** in the project picker at the top.

## 1. Billing and a spending cap (Movezy, needs the company card)

1. **Billing** → link a billing account in Movezy's name to `movezy-df666`.
2. **Billing → Budgets & alerts → Create budget:** a monthly amount Movezy is comfortable with, with alerts at 50%, 90% and 100% sent to the owner's email.

On-screen maps in the Android and iOS apps are free. Address search, geocoding and routes are billed per use, after a monthly free allowance per API. The budget alert catches anything unexpected.

## 2. Turn on the four APIs

**APIs & Services → Library**, search for and **Enable** each:

| API | Used for |
|---|---|
| **Maps SDK for Android** | The map on screen in both Android apps |
| **Places API (New)** | Address search while typing, and opening a picked result |
| **Geocoding API** | "What's at this pin", and the city or state for rate cards and GST |
| **Routes API** | Road distance for fares, route lines on the map, live ETA |

Add **Maps SDK for iOS** later, when the iPhone apps are built. Don't enable anything marked *(Legacy)*.

## 3. Create two API keys

**APIs & Services → Credentials → Create credentials → API key**, twice. Rename each key so it's recognisable.

**Key 1: "Movezy server"** (used only by the backend)
- **Application restrictions:** *None* for now, because Render's outgoing IP isn't fixed. Switch to **IP addresses** with the AWS server's Elastic IP when we move to AWS.
- **API restrictions → Restrict key:** Places API (New), Geocoding API, Routes API.

**Key 2: "Movezy Android apps"** (built into the two apps)
- **Application restrictions → Android apps → Add**, twice:

  | Package name | SHA-1 certificate fingerprint |
  |---|---|
  | `co.movezy.app` | `FD:92:2C:E7:62:F3:93:59:F1:D7:3A:E1:20:57:C0:0D:6B:EE:93:49` |
  | `co.movezy.partner` | `FD:92:2C:E7:62:F3:93:59:F1:D7:3A:E1:20:57:C0:0D:6B:EE:93:49` |

  This fingerprint is the signing key of today's test builds. Before the Play Store release, add the Play upload key and the Play app-signing key fingerprints for both packages.
- **API restrictions → Restrict key:** Maps SDK for Android.

## 4. Optional: daily caps

**APIs & Services →** open each of Places API (New), Geocoding API and Routes API **→ Quotas**. Lower the per-day request limits to a safe ceiling for launch. This is a hard stop, as well as the budget alert.

## 5. Send us the two keys

Send them through the password manager or a one-time link, not chat or email.
- **Server key:** goes in the backend as `GOOGLE_MAPS_API_KEY` (Render now, AWS later).
- **Android key:** goes into the app builds. It is kept out of git, because the repos are public.

## What happens until then

Without the server key, the backend falls back to OpenStreetMap's free public servers for routing, address search and geocoding. That keeps test builds working, but their usage policies don't allow production traffic. With the key set, every lookup goes to Google, and the same app builds keep working with no app change.
