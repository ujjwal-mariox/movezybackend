# Movezy SMS templates (DLT + MSG91)

Indian telecom rules (TRAI DLT) only deliver business SMS whose wording was registered in advance. Each message below must be registered **word for word** on a DLT portal, then added to MSG91 with its DLT template ID. The backend sends only these messages (`src/services/sms.service.ts`, `SMS_TEMPLATES`).

All five fit in one SMS (160 characters or fewer), use plain text without emoji, and keep every variable within DLT's 30-character limit.

## 1. On the DLT portal (Jio, Airtel, Vi or BSNL)

1. Register Movezy as a **Principal Entity** and note the **PE ID** (Entity ID).
2. Register the **header** (sender ID) `MOVEZY`, type Service / Transactional.
3. **Whitelist the URL** used in template 4: `https://maps.google.com`. Add `https://movezy.co` too if template 5 is registered later. SMS carrying links that are not whitelisted are blocked.
4. Register each **content template** below. Template type: **Service Implicit**. Use the "DLT text" column exactly, with `{#var#}` where shown, then note each **DLT template ID**.

| # | Purpose | DLT text |
|---|---|---|
| 1 | Customer login OTP | `{#var#} is your Movezy verification code. It is valid for a few minutes. Do not share it with anyone.` |
| 2 | Driver (partner) login OTP | `{#var#} is your Movezy driver verification code. Valid for a few minutes. Do not share it.` |
| 3 | Parcel picked up, sent to the receiver | `Hi {#var#}, your Movezy parcel {#var#} has been picked up and is on its way. Track it in the Movezy app. - Movezy` |
| 4 | SOS alert to emergency contacts | `EMERGENCY: {#var#} has triggered an SOS alert on Movezy. Location: https://maps.google.com/?q={#var#} - Movezy` |
| 5 | Live location share to emergency contacts (**not needed yet: skip it**) | `{#var#} is sharing their live location with you on Movezy: https://movezy.co/track/{#var#} - Movezy` |

## 2. In MSG91 (control.msg91.com)

1. **SMS → Sender ID:** add `MOVEZY` together with the DLT PE ID.
2. **SMS → Templates → Create Template**, once per row below:
   - **Template Name:** the name in the table.
   - **DLT Template ID:** from the DLT portal.
   - **Sender ID:** `MOVEZY`.
   - **Message content:** the DLT text, with each `{#var#}` replaced by a variable inserted through **Add Variable**. Name the variables exactly as listed. If the panel numbers them instead (`VAR1`, `VAR2`, …, in the order they appear), that works too.
3. Wait for the status **Verified by DLT**, use **Mark default** on the latest version, and use **Test DLT** to send one to your own number.
4. Copy each template's **Template ID** (the copy icon) into the matching setting below.
5. Create an **Auth Key** (MSG91 → API / Authkey).

| # | Template Name | Variables, in order | Server setting for its MSG91 Template ID |
|---|---|---|---|
| 1 | `movezy_customer_otp` | `otp` | `MSG91_TEMPLATE_CUSTOMER_OTP` |
| 2 | `movezy_driver_otp` | `otp` | `MSG91_TEMPLATE_DRIVER_OTP` |
| 3 | `movezy_parcel_picked_up` | `name`, `ref` | `MSG91_TEMPLATE_PARCEL_PICKED_UP` |
| 4 | `movezy_sos_alert` | `name`, `location` | `MSG91_TEMPLATE_SOS_ALERT` |
| 5 | `movezy_location_share` | `name`, `code` | `MSG91_TEMPLATE_LOCATION_SHARE` |

Example of template 3 as it appears in MSG91:
`Hi ##name##, your Movezy parcel ##ref## has been picked up and is on its way. Track it in the Movezy app. - Movezy`

## 3. Server settings

```dotenv
SMS_PROVIDER=msg91
MSG91_AUTH_KEY=<from MSG91>
MSG91_TEMPLATE_CUSTOMER_OTP=<MSG91 template id>
MSG91_TEMPLATE_DRIVER_OTP=<MSG91 template id>
MSG91_TEMPLATE_PARCEL_PICKED_UP=<MSG91 template id>
MSG91_TEMPLATE_SOS_ALERT=<MSG91 template id>
MSG91_TEMPLATE_LOCATION_SHARE=<MSG91 template id>
```

**Template with no ID:** a message whose template ID isn't set is not sent, and it is logged as not sent. Nothing fails silently.

**Before go-live:**
- Remove `MASTER_OTP` once a real OTP arrives on a test phone.
- Template 5 (live-location share) is for a feature that isn't built yet: there's no `/track` page, and nothing in the apps sends it. Don't register it on DLT for now; the backend skips it while it has no template ID.

## What the recipient sees

1. `482913 is your Movezy verification code. It is valid for a few minutes. Do not share it with anyone.`
2. `482913 is your Movezy driver verification code. Valid for a few minutes. Do not share it.`
3. `Hi Asha, your Movezy parcel MVZ1001 has been picked up and is on its way. Track it in the Movezy app. - Movezy`
4. `EMERGENCY: Asha has triggered an SOS alert on Movezy. Location: https://maps.google.com/?q=18.520430,73.856743 - Movezy`
5. `Asha is sharing their live location with you on Movezy: https://movezy.co/track/Ab3dE5fG7hI - Movezy`
