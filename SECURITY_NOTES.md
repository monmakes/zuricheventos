# Zurich Eventos security notes

## Implemented in this static V1

- Added a restrictive Content Security Policy in `index.html` and `_headers`.
- Removed inline JavaScript from the print button so CSP can block inline scripts.
- Replaced unsafe `innerHTML` rendering of customer data, contract preview, success dialog, summary, and admin table with DOM APIs and `textContent`.
- Added client-side input normalization and validation for dates, email, phone, quantities, address, coverage zone, pickup/delivery times, minimum order, and inventory limits.
- Added form length limits and safer autocomplete/input mode attributes.
- Added basic session rate limiting for repeated booking attempts.
- Added a lightweight admin demo gate to prevent casual access to the local dashboard.
- Added safer localStorage parsing with corruption handling and maximum booking count.
- Switched reservation IDs from timestamp-derived IDs to browser crypto-generated IDs.
- Added production deployment headers for Cloudflare Pages/Netlify-style hosts in `_headers`.

## Important trade-offs

This remains a static prototype. Anything enforced only in the browser can be bypassed by a technical user. The admin passcode, same-day booking code, inventory blocking, validation, and mock payment are usability/demo protections, not production-grade security controls.

## Safest production architecture

Before taking real reservations or payments, move these flows to a backend:

- Authentication and role-based authorization for admins.
- Server-side reservation creation and inventory locking.
- Stripe Checkout Session creation on the server only.
- Stripe webhook verification before confirming a reservation.
- Database constraints to prevent overbooking and reservation tampering.
- Reservation lookup using a signed, expiring token or verified email flow, not email + reservation number alone.
- CSRF protection for cookie-based sessions.
- Rate limiting and bot protection at the edge/API layer.
- Secrets in environment variables only.
- Structured logs without storing card data or sensitive personal details unnecessarily.

## Remaining production risks

- No real backend authorization yet.
- No real customer accounts yet.
- No real Stripe webhook confirmation yet.
- No server-side anti-overbooking transaction yet.
- Demo data still lives in localStorage.
- Same-day approval code is still visible in frontend source.

## Second audit update

A second pass found and fixed additional issues: removed the localStorage-configurable admin code, minimized localStorage PII, tightened delivery-time and birthday validation, restricted the DOM helper attribute allowlist, removed unnecessary `data:` image CSP allowance, added `noreferrer` to the external WhatsApp link, and fixed local date handling.

See `SECOND_SECURITY_AUDIT.md` for details.
