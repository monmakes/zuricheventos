# Zurich Eventos V1

Static interactive prototype for online testing.

## What is included
- Premium landing page
- Availability-first booking flow
- Catalog and packages
- Local inventory blocking after mock payment
- Same-day booking code gate: `ZURICH-HOY`
- Contract preview with auto-filled customer/order data
- Mock payment confirmation
- Local admin dashboard
- WhatsApp support links
- Stripe-ready checkout placeholder

## Test locally
Open `index.html` in a browser.

## Deploy online
Upload this folder to Cloudflare Pages, Netlify, Vercel, or any static hosting.

## Recommended production upgrade
Replace localStorage with a real database/API, for example:
- Softr + Airtable + Make for low-code
- Webflow + Airtable/Supabase + Make
- Custom Next.js + Supabase + Stripe Checkout

## Future Stripe integration points
- In `app.js`, replace the booking form submit handler's mock payment section with a call to a backend endpoint that creates a Stripe Checkout Session.
- Store booking as `pending_payment` before redirecting to Stripe.
- Confirm booking and block inventory only after `checkout.session.completed` webhook.
- Generate and email PDF contract after payment confirmation.

## Notes
This is a V1 prototype, not a legal/payment production system. Validate legal copy, privacy consent, tax workflow, and Stripe deposit authorization flow before launch.


## Security update implemented
- Added CSP/security headers via `_headers` and CSP meta tag.
- Removed inline JavaScript handlers.
- Replaced unsafe `innerHTML` rendering of customer data with safe DOM rendering.
- Added client-side validation, normalization, quantity clamping, and rate limiting for the demo flow.
- Added a demo-only admin passcode gate. Default: `demo-admin`. You can change it in the browser console for local testing with `localStorage.setItem("zurichDemoAdminCode", "your-code")`.

## Production warning
This is still not production-ready for real payments, accounts, admin access, or personal customer data. Browser-only controls are bypassable. Use a backend with server-side validation, authorization, database transactions, Stripe Checkout Sessions, and verified Stripe webhooks before launch. See `SECURITY_NOTES.md`.

## V3 catalog and copy update
- Added accessible image sliders for products.
- Replaced product photography and removed the standalone linen item.
- Added the adjustable 4-foot auxiliary table.
- Added package vs. per-piece pricing to the booking calculator.
- Clarified that the 15% deposit is paid at delivery and is not part of checkout.
- Added a full guarantees section and revised brand copy.
