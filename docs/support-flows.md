# Guided support conversations

Generated from `src/config/support-flows.ts` by `src/scripts/support-flows-doc.ts`. Edit the config, then rerun the script.

How it works, in both apps' Help & Support chat:

1. The assistant offers the topics below as tap chips. Each tap shows the next set of chips.
2. At the end of a path, the assistant answers. The user then taps **That helped** or **Still need help**. Still need help opens a chat with an agent, with the path already on the ticket.
3. In the agent chat, after each agent message the user gets follow-up chips. Those come from the issue, else its topic, else the defaults. Typing a custom message always works.
4. In the admin panel, the agent sees the issue's suggested replies first, then the general quick replies.

Default user follow-ups: "Thanks, that solved it", "I still need help", "Please call me".

**Please confirm with Movezy:**

- refund times (5–7 working days)
- payout timing (1–2 working days after approval)
- that coins are credited after a completed trip

## Customer app (Movezy)

- **Booking issues** _(ticket category BOOKING)_
  - Assistant asks: "What's the problem with your booking?"
  - **No driver has accepted yet**
    - Assistant answers: "At busy times it can take a few minutes to find a partner. Keep the search open; we offer the booking to the nearest partners one by one. You can also cancel and try a different vehicle type."
    - User chips after an agent reply: "It's been more than 10 minutes", "I want a different vehicle", "Please cancel my booking"
    - Agent suggestion "Searching nearby": "We're still looking for a partner near your pickup. I've flagged your booking so it's offered to more partners."
    - Agent suggestion "Suggest vehicle change": "No partner with this vehicle type is free nearby right now. A different vehicle type may be quicker; shall I help you rebook?"
  - **Change pickup, drop or stops**
    - Assistant answers: "Before pickup you can add a stop from the trip screen. To change the pickup or drop, tell us the new address and we'll update the booking with your driver."
    - User chips after an agent reply: "Change the drop location", "Add a stop", "Change the pickup time"
    - Agent suggestion "Ask for new address": "Sure. Please share the new address (or a landmark) and I'll update it with your driver."
  - **Cancel a booking**
    - Assistant asks: "What would you like to know?"
    - **How do I cancel?**
      - Assistant answers: "Open the booking from the trip screen or Booking history and tap Cancel. Pick a reason, and the app shows any cancellation charge before you confirm."
      - Agent suggestion "Cancel steps": "Open the booking, tap Cancel, choose a reason and confirm. Any charge is shown before you confirm."
    - **Why was I charged for cancelling?**
      - Assistant answers: "The charge depends on the reason you pick and how far the trip had got, for example once a partner is on the way. The cancel screen shows exactly what you'll get back before you confirm."
      - User chips after an agent reply: "The driver never came", "I cancelled before the driver was assigned"
      - Agent suggestion "Fee reviewed": "I've checked your booking. The charge followed our cancellation policy for the reason and stage of the trip. If something else happened, tell me and I'll review it."
      - Agent suggestion "Fee reversed": "You're right — I've reversed the cancellation charge. It will reach your original payment method in 5–7 working days."
  - **Scheduled booking**
    - Assistant asks: "What's wrong with the scheduled booking?"
    - **Change the date or time**
      - Assistant answers: "Scheduled bookings can't be moved in the app yet. Cancel it and book again for the new time, or ask us to change it."
      - Agent suggestion "Ask new time": "Sure — what date and time would you like? I'll update the booking."
    - **No driver came for it** _(priority HIGH)_
      - Assistant answers: "We start finding a partner 30 minutes before the scheduled time. If none was available, you won't be charged. Tell us and we'll help you rebook."
      - Agent suggestion "Apologise and rebook": "Sorry no partner was available at your scheduled time. You haven't been charged. Shall I help you rebook right now?"
- **Payments & refunds** _(ticket category PAYMENT)_
  - Assistant asks: "What's the payment issue?"
  - **Money deducted, booking failed**
    - Assistant answers: "If money left your account but no booking was made, it's refunded automatically to the original payment method. Banks usually take 5–7 working days to show it."
    - User chips after an agent reply: "It's been more than 7 days", "I want to share the transaction ID"
    - Agent suggestion "Refund in progress": "I can see the payment. The refund has been initiated and should reach your account within 5–7 working days."
    - Agent suggestion "Ask transaction ID": "Please share the transaction ID or UTR from your bank/UPI app so I can trace the payment."
  - **Where is my refund?**
    - Assistant answers: "Refunds go back to the original payment method. Card and UPI refunds usually take 5–7 working days after we process them. You'll see the status on the booking in Booking history."
    - User chips after an agent reply: "It's been more than 7 days", "I haven't received a refund"
    - Agent suggestion "Refund processed": "Your refund was processed on our side. Banks usually take 5–7 working days to show it."
  - **Charged more than the estimate**
    - Assistant answers: "The final fare can change with waiting time beyond the free minutes, extra stops, tolls or parking. Open the booking and check its Fare breakup to see each charge."
    - User chips after an agent reply: "The breakup looks wrong", "I was charged for waiting I didn't cause"
    - Agent suggestion "Explain breakup": "I've checked your fare. The extra came from the charges listed in the Fare breakup. Is there one that looks wrong?"
    - Agent suggestion "Waiting charge reviewed": "I've reviewed the waiting time on your trip and adjusted the charge. The difference will be refunded in 5–7 working days."
  - **Wallet or Movezy Coins**
    - Assistant asks: "What's wrong with your wallet?"
    - **Added money but it's not in my wallet**
      - Assistant answers: "Wallet top-ups usually show within a few minutes. If money was deducted and it still isn't there, it's refunded automatically in 5–7 working days, or tell us and we'll check."
      - Agent suggestion "Wallet credited": "I've checked and credited the amount to your wallet. Please reopen the app to see it."
    - **Coins not credited**
      - Assistant answers: "Coins are credited after a trip is completed and appear in Movezy Rewards. They can take a few minutes after the trip ends."
      - Agent suggestion "Coins added": "I've added the missing coins to your account."
  - **Invoice or GST bill**
    - Assistant answers: "Open the booking in Booking history to download its invoice. To get your GSTIN on invoices, add it in Profile before booking."
    - Agent suggestion "Invoice resent": "I've generated the invoice again. You'll find it on the booking in Booking history."
- **Driver or delivery problem** _(ticket category DRIVER)_
  - Assistant asks: "What happened?"
  - **Driver is late or not moving**
    - Assistant answers: "You can track your driver live on the trip screen and call or chat with them from there. If they still aren't moving, tell us and we'll contact them."
    - User chips after an agent reply: "The driver isn't answering", "I want to cancel"
    - Agent suggestion "Contacting driver": "I'm contacting your driver now and will update you here in a moment."
  - **Driver asked for extra money** _(priority HIGH)_
    - Assistant answers: "Please pay only the amount shown in the app, and don't pay extra in cash. Tell us what happened and we'll take it up with the partner."
    - Agent suggestion "Do not pay extra": "Please don't pay anything beyond the in-app fare. I've reported this to our partner team and we'll follow up with the driver."
  - **Driver behaviour** _(priority HIGH)_
    - Assistant answers: "We're sorry. Tell us what happened and we'll take it up with the partner. If you ever feel unsafe, use the SOS button on the trip screen or call 112."
    - Agent suggestion "Acknowledge complaint": "I'm sorry this happened. Thank you for telling us — I've raised it with our partner team, and we take it seriously."
  - **Goods damaged or missing** _(priority HIGH)_
    - Assistant answers: "We're sorry. Please share photos of the damage and a short description; our team will look into it with the partner."
    - User chips after an agent reply: "I'll share photos", "Something is missing"
    - Agent suggestion "Ask for photos": "I'm sorry about this. Please share photos of the goods and the packaging so we can investigate with the partner."
  - **Problem with the delivery OTP**
    - Assistant answers: "The drop OTP is shown on your trip screen; share it with the driver only when your goods have arrived. If it isn't working, tell us and we'll help complete the trip."
    - Agent suggestion "Help complete trip": "I can see the trip. Please confirm your goods have been delivered and I'll help close it."
- **Account** _(ticket category ACCOUNT)_
  - Assistant asks: "What do you need help with?"
  - **Can't log in**
    - Assistant asks: "What happens when you try?"
    - **OTP not received**
      - Assistant answers: "Check the number is right, wait 60 seconds and tap Resend. Make sure you have network coverage; OTPs aren't blocked by DND."
      - User chips after an agent reply: "Still no OTP", "I've changed my number"
      - Agent suggestion "OTP checks": "Please confirm the number you're entering. I can see the OTP requests; try once more and let me know if it arrives."
    - **My account is blocked**
      - Assistant answers: "Accounts are blocked only for safety or policy reasons. Ask an agent and we'll review it."
      - Agent suggestion "Reviewing block": "I'm checking your account status now. I'll update you here once it's reviewed."
  - **Change my phone number**
    - Assistant answers: "For your security, phone numbers are changed through support. Tell us your current and new number."
    - Agent suggestion "Verify ownership": "To change the number, please share your registered email or a recent booking ID so I can confirm it's your account."
  - **Update name or email**
    - Assistant answers: "Go to Profile and tap Edit profile to change your name or email."
  - **Delete my account**
    - Assistant answers: "Go to Profile → Delete account. You're signed out at once, and you can keep the account by signing in again within 30 days."
- **App problems** _(ticket category APP)_
  - Assistant asks: "What's not working?"
  - **App crashes or freezes**
    - Assistant answers: "Update Movezy to the latest version from the Play Store, then restart your phone. If it still happens, tell us your phone model."
    - User chips after an agent reply: "It still crashes", "I'm on the latest version"
    - Agent suggestion "Ask device details": "Thanks. Which phone model and Android version are you using, and on which screen does it happen?"
  - **Location or map not working**
    - Assistant answers: "Turn on location, and allow Movezy to use it in your phone's Settings → Apps → Movezy → Permissions."
  - **Not getting notifications**
    - Assistant answers: "Allow notifications for Movezy in your phone's settings, and keep the app updated."
- **Something else** _(ticket category OTHER, goes straight to an agent)_
  - Assistant answers: "No problem — tell us what you need and our team will help."

## Partner app (Movezy Partner)

- **Emergency** _(ticket category EMERGENCY, priority URGENT, goes straight to an agent)_
  - Assistant answers: "Connecting you to our safety team now. If anyone is in danger, call 112."
  - Agent suggestion "Safety check": "We're with you. Are you safe right now? Share your location if you can, and call 112 if anyone is in danger."
- **Earnings & payouts** _(ticket category PAYMENT)_
  - Assistant asks: "What's the issue with your earnings?"
  - **Payout not received**
    - Assistant answers: "Payouts are sent after the Movezy team approves them; bank transfers can then take 1–2 working days. Check the payout status in My wallet."
    - User chips after an agent reply: "It's been more than 2 days", "My bank details are wrong"
    - Agent suggestion "Payout status": "I've checked your payout. It's approved and should reach your bank within 1–2 working days."
    - Agent suggestion "Payout sent": "Your payout has been sent. Please check your bank statement; share the date if you can't see it."
  - **Earning for a trip looks wrong**
    - Assistant answers: "Open the trip in Trip history to see the fare, the commission and your earning. Tell us the trip and what looks wrong."
    - User chips after an agent reply: "Waiting time wasn't paid", "Tolls or parking weren't added"
    - Agent suggestion "Explain earning": "I've checked the trip. Your earning is the fare minus the commission shown on the trip. Which part looks wrong?"
  - **Wallet recharge failed**
    - Assistant answers: "If money was deducted but your wallet didn't go up, it's refunded automatically within 5–7 working days. Tell us if it's been longer."
    - Agent suggestion "Recharge credited": "I've checked the payment and credited your wallet. Please reopen the app to see it."
  - **Change bank details**
    - Assistant answers: "Go to Profile → Bank details. Changes are reviewed before payouts use the new account."
- **Documents & verification** _(ticket category DOCUMENTS)_
  - Assistant asks: "Which of these is it?"
  - **Verification is still pending**
    - Assistant answers: "Our team reviews documents in the order they arrive. You'll get a notification as soon as yours are approved."
    - User chips after an agent reply: "It's been more than 2 days", "I uploaded the wrong document"
    - Agent suggestion "Under review": "Your documents are in the review queue. I've flagged them so you get an update soon."
  - **My document was rejected**
    - Assistant answers: "Open Profile or My vehicles to see the reason, then upload a clear photo of the whole document in good light."
    - Agent suggestion "Re-upload tips": "The photo was unclear. Please upload it again with all four corners visible and no glare."
  - **Licence, RC or insurance expiring**
    - Assistant answers: "Update your licence from Profile, and RC, insurance or PUC from My vehicles → Update documents. Upload before the expiry date to keep getting bookings."
- **Trips & bookings** _(ticket category TRIPS)_
  - Assistant asks: "What's happening?"
  - **I'm not getting bookings**
    - Assistant answers: "Stay online in an area with demand and keep your documents valid. Bookings go to the nearest free partner first, one at a time."
    - User chips after an agent reply: "My documents are valid", "I'm online but get nothing"
    - Agent suggestion "Check status": "I've checked your account: you're active and your documents are valid. Bookings go to the nearest partner first, so moving closer to busy areas helps."
  - **Customer isn't at pickup** _(priority HIGH)_
    - Assistant answers: "Wait at the pickup and call the customer from the app; waiting beyond the free minutes is charged to them. If they don't come, tell us before cancelling."
    - Agent suggestion "Contacting customer": "I'm calling the customer now. Please wait a few more minutes; waiting time is being recorded."
  - **Pickup or drop OTP not working** _(priority HIGH)_
    - Assistant answers: "Ask the customer for the OTP shown on their trip screen. If it still fails, tell us and we'll help complete the step."
    - Agent suggestion "Help with OTP": "I can see the trip. Please confirm you're at the location and I'll help complete this step."
  - **Problem during a trip** _(priority HIGH)_
    - Assistant answers: "Tell us what happened and we'll help right away. If anyone is in danger, use SOS or call 112."
- **App problems** _(ticket category APP)_
  - Assistant asks: "What's not working?"
  - **I keep going offline**
    - Assistant answers: "Allow location 'All the time', and turn off battery optimisation for Movezy Partner in your phone's settings."
    - Agent suggestion "Battery settings": "Please open Settings → Apps → Movezy Partner → Battery and set it to Unrestricted, then go online again."
  - **App crashes or freezes**
    - Assistant answers: "Update Movezy Partner from the Play Store and restart your phone. If it still happens, tell us your phone model."
    - User chips after an agent reply: "It still crashes", "I'm on the latest version"
  - **Booking alerts not ringing**
    - Assistant answers: "Allow notifications for Movezy Partner and keep the phone off silent. Bookings ring while you're online."
- **Account** _(ticket category ACCOUNT)_
  - Assistant asks: "What do you need help with?"
  - **Change my phone number**
    - Assistant answers: "For your security, numbers are changed through support. Tell us your current and new number."
  - **My account is suspended**
    - Assistant answers: "Suspensions follow a document expiry or a policy review. Check your documents, or ask us and we'll review it."
    - Agent suggestion "Reviewing suspension": "I'm checking why your account was suspended and will update you here."
  - **Delete my account**
    - Assistant answers: "Go to Profile → Delete account. Withdraw any earnings first; you can keep the account by signing in again within 30 days."
- **Something else** _(ticket category OTHER, goes straight to an agent)_
  - Assistant answers: "No problem — tell us what you need and our team will help."
