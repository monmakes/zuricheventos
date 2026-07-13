# Second security audit: fixes applied

I re-audited the hardened prototype assuming the first pass had mistakes. It did. These are the issues found and corrected.

## 1. Demo admin gate was misleading and user-controllable

**Issue:** The first pass allowed the demo admin passcode to be overridden from `localStorage` via `zurichDemoAdminCode`. Any user with DevTools could set their own code and unlock the dashboard. Static-site admin cannot be made truly secure.

**Correction:** Removed the localStorage-configurable passcode. The dashboard now uses an explicit demo acknowledgement phrase and no longer claims to provide real authorization.

**Trade-off:** This is still not real security. The safe production alternative remains a backend admin dashboard with real authentication, role-based access control, server-side sessions, audit logs, and no admin data shipped to browsers unless authorized.

## 2. Customer PII was still being stored in localStorage

**Issue:** The first pass still saved customer name, email, phone, address, birthday, and notes in browser storage. This is sensitive personal information and can be read by anyone with access to the device/browser profile or by any future XSS bug.

**Correction:** Demo booking storage now minimizes data. It stores only operational demo fields plus masked customer display name and masked email. It does not store phone, address, birthday, or notes.

**Trade-off:** The local demo admin can no longer show full customer details. That is intentional. Production should store PII only in a backend database with access controls, retention rules, encryption at rest where appropriate, and privacy notice alignment.

## 3. Delivery time validation was incomplete

**Issue:** The first pass checked that a delivery time existed but did not verify that the selected value was one of the allowed delivery hours for that date.

**Correction:** Added server-style client validation that delivery time must match the allowed generated slots for the selected event date.

**Trade-off:** None for the current UI. In production this must also be enforced server-side.

## 4. Birthday field was not validated

**Issue:** Optional birthday values were accepted without validation. Invalid or future dates could enter stored booking data.

**Correction:** Added validation for optional birthday date format and rejected future dates. Also stopped storing birthday locally.

**Trade-off:** None.

## 5. DOM helper was too permissive for future code changes

**Issue:** The helper function used to create elements allowed arbitrary attributes. Even though current calls were safe, future edits could accidentally set unsafe attributes such as inline event handlers.

**Correction:** Restricted allowed attributes in the helper to a small allowlist and continued using `textContent` for user-controlled text.

**Trade-off:** If future code needs additional attributes, they must be added intentionally to the allowlist.

## 6. CSP allowed `data:` images unnecessarily

**Issue:** `img-src 'self' data:` was broader than needed for this site.

**Correction:** Removed `data:` from `img-src` in both `index.html` and `_headers`.

**Trade-off:** Inline/base64 images will no longer render. Current assets are local files, so the existing UI is preserved.

## 7. External link hardening was incomplete

**Issue:** The WhatsApp link used `target="_blank"` with `noopener` but not `noreferrer`.

**Correction:** Added `noreferrer`.

**Trade-off:** WhatsApp will receive less referrer information, which is good for privacy.

## 8. Local date calculation used UTC

**Issue:** `todayISO()` used `toISOString()`, which can be off by one day around local midnight depending on timezone.

**Correction:** Replaced it with local date construction.

**Trade-off:** None.

## Updated security score

- Static prototype score after second pass: **62/100**
- Real production score for payments, customer accounts, admin, and reservation management: **still not production-ready** until the backend architecture is implemented.

## Remaining risks

- Browser-only validation and rate limiting are bypassable.
- Inventory locking is not atomic and not reliable across users/devices.
- No real authentication, authorization, customer accounts, or admin RBAC.
- No real Stripe Checkout Session creation or webhook verification.
- No CSRF protection because there is no backend session yet.
- No secure reservation lookup flow yet.
- The same-day code is still visible in frontend source and must not be used for production authorization.

## Required production path

Before launch, migrate to a backend such as Next.js API routes + Supabase/Postgres + Stripe Checkout. Enforce all validation, authorization, rate limiting, reservation ownership, inventory locks, and Stripe webhook confirmation server-side.
