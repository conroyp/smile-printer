# Smile Printer

A small reference app that rewards a smile with 10% off a coffee, takes an in-person payment with Stripe Terminal, and prints the customer’s photo on a Verifone V660p receipt.

Face detection and smile analysis happen in the browser. Live camera frames and face landmarks are never sent to this server or to Stripe.

> This is an educational reference implementation, not a ready-made point-of-sale system. See [Before using this in production](#before-using-this-in-production).

## The experience

1. The operator chooses how many coffees are in the order.
2. The customer holds still while the face outline changes from red to orange.
3. Holding a smile for one second turns the outline green, captures one photo, and applies the discount.
4. The operator selects an online V660p and presses **Pay**.
5. The Node server asks the reader to process a card-present PaymentIntent and waits for confirmed success.
6. Only then does the browser upload the receipt image for printing. A successful print resets the order.

If no compatible online reader is available, the Pay button remains disabled. If payment succeeds but printing fails, the same receipt can be retried without creating another charge.

## What is in the demo?

- Plain HTML and browser JavaScript with Tailwind’s browser CDN—no build step
- Native `getUserMedia()` camera capture
- MediaPipe Face Landmarker running in a dedicated Web Worker
- A red → orange → green face and smile state machine
- Browser-side portrait processing tuned for a monochrome thermal printer
- A small Express server using the Stripe Node library
- Server-driven Terminal payment processing and completion polling
- V660p `print_content` submission and print-result polling
- Tests for the HTTP API, payment flow, printing, worker lifecycle, and image processing

The browser does not load the Stripe Terminal JavaScript SDK. The V660p is a smart reader, so this project uses Stripe’s [server-driven integration](https://docs.stripe.com/terminal/payments/collect-card-payment?terminal-sdk-platform=server-driven): the browser calls this app’s API, the API calls Stripe, and the reader communicates with Stripe over the internet.

## Prerequisites

- Node.js 20.11 or newer
- A Stripe account and test-mode secret key
- A V660p registered to the same Stripe account and showing as online
- A modern browser with camera access

V660p and embedded printing availability varies by country and can be preview-only. Check Stripe’s current [V660p availability and setup guide](https://docs.stripe.com/terminal/payments/setup-reader/v660p) before starting.

## Quick start

Install dependencies and create a local environment file:

```bash
npm install
cp .env.example .env
```

Add your Stripe test key to `.env`:

```dotenv
STRIPE_SECRET_KEY=sk_test_...
```

Start the app:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). `localhost` is treated as a secure browser context, so camera access works without a local TLS certificate. Use HTTPS for any other hostname.

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `STRIPE_SECRET_KEY` | — | Server-side Stripe secret key; required |
| `STRIPE_CONNECTED_ACCOUNT_ID` | — | Connected account that owns the reader, if using Connect |
| `STRIPE_CURRENCY` | `eur` | Three-letter payment currency |
| `COFFEE_PRICE` | `430` | Unit price in the currency’s smallest unit |
| `PORT` | `3000` | HTTP port |
| `PAYMENT_POLL_ATTEMPTS` | `90` | Maximum PaymentIntent and reader status checks |
| `PAYMENT_POLL_INTERVAL_MS` | `1000` | Delay between payment checks |
| `PRINT_POLL_ATTEMPTS` | `15` | Maximum print status checks |
| `PRINT_POLL_INTERVAL_MS` | `1000` | Delay between print checks |

The default price is €4.30. In Stripe test mode, amount endings trigger particular payment outcomes; €4.30 keeps the normal and discounted totals for one to four coffees away from those special endings.

## How it works

```text
Browser                           Node server                     Stripe / V660p
   │                                   │                                │
   │  camera → worker → smile score    │                                │
   │  capture + render receipt locally │                                │
   │                                   │                                │
   │── POST /api/payments ────────────>│── create PaymentIntent ───────>│
   │                                   │── process on reader ──────────>│
   │                                   │── poll reader + intent ───────>│
   │<── confirmed payment ─────────────│<───────────────────────────────│
   │                                   │                                │
   │── POST /api/receipts/print ──────>│── validate + optimize image    │
   │                                   │── submit print_content ───────>│
   │                                   │── poll print action ──────────>│
   │<── confirmed print ───────────────│<───────────────────────────────│
   │  reset order                      │                                │
```

### Browser responsibilities

- Capture camera frames and transfer at most one frame at a time to the worker.
- Track face position and smile duration.
- Keep the captured photo in memory.
- Render a 384px-wide, black-and-white receipt canvas.
- Submit order choices and, after payment, the completed receipt image.

### Server responsibilities

- Keep the Stripe secret key out of the browser.
- Recalculate the charge from the configured price, quantity, and discount state.
- Find online readers whose `device_type` is `verifone_v660p`.
- Create and process a card-present PaymentIntent.
- Confirm both the reader action and PaymentIntent before accepting the receipt.
- Bind the paid PaymentIntent to the reader selected for the order.
- Validate and optimize the receipt before calling Stripe’s [`print_content` endpoint](https://docs.stripe.com/terminal/features/print-content?locale=en-GB).

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Basic process health check |
| `GET` | `/api/config` | Publish safe shop settings to the browser |
| `GET` | `/api/printers` | List compatible online V660p readers |
| `POST` | `/api/payments` | Create, process, and await a Terminal payment |
| `POST` | `/api/receipts/print` | Verify the payment, optimize the image, and await printing |

## Privacy boundary

| Data | Where it is processed | Leaves the browser? |
|---|---|---|
| Live video frames | Browser worker | No |
| Face landmarks and smile score | Browser worker | No |
| Captured portrait | Browser memory | Only after payment, as part of the receipt |
| Receipt image | Node server and Stripe | Yes, solely for printing |
| Payment details | Stripe and the V660p | Yes |

MediaPipe is installed from npm and served locally by this app. The browser loads Tailwind’s development runtime from jsDelivr, fonts from Google Fonts, and the face model from Google’s model storage, but video frames are not sent with those requests. This app does not write captured images or generated receipts to disk, and the browser discards its in-memory copy when the order resets.

## Implementation notes

### Face detection lifecycle

[`FaceDetectorClient`](frontend/face-detector.js) uses `requestVideoFrameCallback()` when available and allows only one transferable `ImageBitmap` to be in flight. Face Landmarker inference runs inside [`face-landmarker.worker.js`](frontend/face-landmarker.worker.js), which returns only a normalized face box and smile score.

Initialization tries the MediaPipe GPU delegate, then creates a fresh CPU worker if GPU setup fails. On `pagehide`, the app cancels frame callbacks, stops every camera track, clears the video element, and terminates the worker. It intentionally avoids calling MediaPipe’s synchronous `close()` during navigation because that call has [been reported to freeze browser processes](https://github.com/google-ai-edge/mediapipe/issues/5718).

### Payment and retry safety

The server calculates the amount rather than accepting an arbitrary total from the browser. A browser-generated idempotency key is reused when a payment request is retried. The server waits for the reader action and then the PaymentIntent to report success before the receipt endpoint can print. If polling or the browser request times out, the order remains locked and the main action changes to **Check payment**, which reuses the original key rather than starting a new checkout.

If printing fails, the browser keeps the paid PaymentIntent ID and changes the main action to **Retry receipt**. That path calls only the print endpoint; it does not create another PaymentIntent.

### Receipt image treatment

[`receipt.js`](frontend/receipt.js) owns the receipt layout. [`receipt-image.js`](frontend/receipt-image.js) scales the portrait to fit within 320 × 410 pixels, normalizes its 2nd and 98th luminance percentiles, lifts shadows with a gamma of 0.8, applies a small unsharp mask, and converts it to exact black and white pixels with serpentine Atkinson dithering.

The server uses Sharp to enforce Stripe’s printing constraints: a 384px-wide, two-colour PNG no larger than 100KB. The receipt ends with 72 blank pixels so its footer clears the tear bar. Both the image profile and feed length are named constants near the top of their respective modules.

## Project structure

```text
frontend/
  index.html                  Page structure
  app.js                     UI, camera, and transaction orchestration
  face-detector.js           Main-thread worker client and lifecycle
  face-landmarker.worker.js  MediaPipe inference
  receipt.js                 Receipt layout and rendering
  receipt-image.js           Portrait normalization and dithering
server/
  index.js                   Process entry point
  app.js                     Express routes and request validation
  config.js                  Environment configuration
  terminal-service.js        Stripe payments and printing
  errors.js                  Safe public error responses
test/                         Node test suite
```

## Tests

```bash
npm test
```

The suite uses Node’s built-in test runner and mocked Stripe services. It does not make payments, contact a physical reader, or require a Stripe key.

## Troubleshooting

### No compatible printers found

- Confirm the V660p is registered, powered on, connected, and marked online in Stripe.
- Confirm `.env` contains a key for the same test or live mode as the reader.
- If using Connect, set `STRIPE_CONNECTED_ACCOUNT_ID` to the account that owns the reader.
- Confirm V660p support is enabled for your Stripe account and region.

### The camera does not start

- Use `localhost` or HTTPS.
- Allow camera access in the browser’s site settings.
- Close another application if it has exclusive use of the camera.
- Reload after changing permissions. The page lifecycle cleanup stops camera tracks and terminates the inference worker during navigation.

### A test payment is declined

Stripe Terminal uses the last two digits of test amounts to simulate outcomes. The default coffee price avoids the special endings for the most common one-to-four-coffee cases. If you change `COFFEE_PRICE`, check Stripe’s [Terminal testing guidance](https://docs.stripe.com/terminal/payments/collect-card-payment?terminal-sdk-platform=server-driven) before assuming the integration is failing.

### Payment succeeded but the receipt did not print

The operator can resolve the paper, cover, connectivity, or busy state and press **Retry receipt**. The app retains the successful PaymentIntent and does not charge the customer again.

## Before using this in production

This repository deliberately stays small enough to explain. A production deployment should also include:

- Operator authentication and authorization
- Compiled CSS in place of Tailwind’s development-only browser CDN
- HTTPS, rate limiting, request logging, and monitoring
- A consent and retention policy appropriate to receipt photographs
- A server-verifiable discount claim instead of trusting the browser flag
- Durable transaction state and webhook-backed recovery across browser or server restarts
- Reconciliation, refund, cancellation, and abandoned-payment handling
- A legal and regional review of receipt content and biometric/privacy obligations
- Your own product copy, branding, accessibility review, and end-to-end reader tests

## License

[MIT](LICENSE) © 2026 Paul Conroy
