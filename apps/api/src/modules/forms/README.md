# Capture forms — the tenant's own questions, on somebody else's page

`FR-CAP-2`, `FR-CAP-3`, `FR-CAP-4`, `FR-CAP-5`. A form is the first capture channel that does not
belong to a signed-in person: it is rendered on a website this product does not control and filled
in by somebody who has never seen the product. Everything in this module follows from that.

## Tables

| Table              | What it holds                                                                      |
| ------------------ | ---------------------------------------------------------------------------------- |
| `forms`            | A form: its name, its slug, its **public key**, where captures land, its own copy  |
| `form_fields`      | One question each — a standard lead field **or** one of the workspace's own fields |
| `form_submissions` | Every submission, whatever became of it, with the payload exactly as sent          |

`leads.form_id` and `lead_touchpoints.form_id` were added with this step: "which form brought this
lead" and "which form brought them back" are questions attribution has to be able to answer, and a
touchpoint that only knows the channel cannot.

## Endpoints

| Method   | Path                             | Permission                 |
| -------- | -------------------------------- | -------------------------- |
| `GET`    | `/forms`                         | `form:read`                |
| `GET`    | `/forms/builder-options`         | `form:manage`              |
| `GET`    | `/forms/submissions`             | `form:read`                |
| `GET`    | `/forms/:id`                     | `form:read`                |
| `POST`   | `/forms`                         | `form:manage`              |
| `PATCH`  | `/forms/:id`                     | `form:manage`              |
| `PUT`    | `/forms/:id/fields`              | `form:manage`              |
| `POST`   | `/forms/:id/rotate-key`          | `form:manage`              |
| `DELETE` | `/forms/:id`                     | `form:manage`              |
| `GET`    | `/public/forms/:key`             | **public** (the key is it) |
| `POST`   | `/public/forms/:key/submissions` | **public** (the key is it) |

`form:read` and `form:manage` are separate permissions and neither supports a data scope: a form
belongs to the workspace rather than to a branch, and `form:manage` decides which pipeline every
capture enters, which source it is attributed to and which rule assigns it. The marketing manager
template holds both; the sales manager and the auditor hold `form:read`; a sales executive holds
neither.

## The decisions

- **The public key is the authentication and the tenant resolution at once**
  ([ADR-0029](../../../../../docs/decisions/ADR-0029-a-public-form-is-identified-by-its-own-key.md)).
  32 random characters, globally unique, rotatable, floored at 16 by
  `forms_public_key_long_enough`. The slug stays the workspace's own name for the form, unique
  among its **live** forms only, so a deleted "contact-us" can be made again.
- **A deactivated form answers 404**, exactly as a key that never existed does. Any other answer
  makes the key an oracle for "which workspaces exist".
- **The submission row is written before the capture is attempted.** `FR-CAP-3` asks that the
  payload persist "independent of whether lead creation succeeded", and a row written afterwards is
  precisely the row that is missing when it did not. So the status starts at `received` — an
  amendment to `docs/database-design.md` §8, which listed only the four outcomes — and the outcome
  is an update.
- **One ingestion path.** A submission goes through `LeadsService.create`, the same method the lead
  form and the import use, so duplicate detection, scoring, assignment, the SLA clock, the timeline
  and the events all happen exactly as they do everywhere else. The form's own `formId`, `formName`
  and `formAnswers` travel as a `CaptureContext` the HTTP schema cannot carry — a client that could
  set them could fabricate a form submission and the attribution that comes with it.
- **What a form may ask for is a short, fixed list** (`FORM_STANDARD_FIELDS` in `@leados/shared`),
  plus the workspace's own lead fields. `statusId`, `assignedUserId`, `score` and the rest are not
  on it and never will be: a public form that offered them would let anybody set them.
- **A free-text message goes on the timeline.** There is no `notes` column on a lead in this phase,
  and "I need possession by March" is the reason for the call — so every answer is recorded as a
  `lead.form_submitted` entry carrying label and value, in the capture's own transaction.
- **A bot is thanked, not told.** The honeypot (`website_url`, a fixed name so the renderer and the
  endpoint cannot disagree) is recorded as a refusal and answered with the thank-you. A 400 would
  teach a spam tool to leave the hidden field alone.
- **Two rate-limit counters**, per form (300/hour) and per address (30/hour), for the reason the
  login throttle has two. The per-address figure is deliberately loose: a carrier NAT or an office
  router puts hundreds of real people behind one address, and on this endpoint refusing a genuine
  enquiry is the expensive failure. Fails closed — an unlimited public write endpoint is the worse
  outcome when Redis is down.
- **The address is hashed, never stored.** `form_submissions.ip_hash` is an HMAC under the
  deployment's master key — enough to count submissions from one place, not a record of where a
  member of the public was sitting.

## Example payloads

```http
POST /api/v1/forms
{ "name": "Website enquiry",
  "settings": { "thankYouMessage": "Thanks — we will call you today.", "submitLabel": "Send" },
  "fields": [
    { "standardFieldKey": "fullName", "label": "Your name", "isRequired": true },
    { "standardFieldKey": "phone", "label": "Mobile number", "isRequired": true },
    { "customFieldDefinitionId": "…", "label": "Which service", "isRequired": true, "stepIndex": 1 },
    { "standardFieldKey": "message", "label": "What do you need?", "stepIndex": 1 }
  ] }

GET /api/v1/public/forms/8Kx…           → the definition a renderer draws from
POST /api/v1/public/forms/8Kx…/submissions
{ "answers": { "standard:fullName": "Rohit Kulkarni", "standard:phone": "98450 12345",
               "standard:message": "Need a 3BHK interior before Diwali" },
  "utm": { "utm_source": "google", "utm_medium": "cpc" },
  "pageUrl": "https://example.test/contact" }
→ { "received": true, "message": "Thanks — we will call you today.", "redirectUrl": null }
```

## What is not here yet

- **The embed snippet is a copyable `<script>`/`<iframe>` on the form's screen**, not a hosted
  loader: a one-line embed that renders inside the host page arrives with the website builder in
  Phase 9, which is where a cross-origin asset belongs.
- **CAPTCHA** is a settings flag with no provider behind it. The honeypot and the rate limit are the
  defences today, and a CAPTCHA that nobody has configured would be a tick box that does nothing.
- **"Create a custom field from this unmapped answer"** (`FR-CAP-5`'s one-click half) arrives with
  the public lead API in the next step, where the same surfacing is needed for a payload nobody
  mapped at all. Unmapped answers are kept and logged today.
- **`inbound_payloads`**, the never-lose store for the public API and the ad connectors, is the next
  step's table. A form's own payload is kept in `form_submissions`, which is the same guarantee for
  this channel.
