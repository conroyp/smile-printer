import sharp from "sharp";
import Stripe from "stripe";
import { AppError } from "./errors.js";

const MAX_STRIPE_IMAGE_BYTES = 100 * 1024;
const MAX_SOURCE_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 4_000_000;
const MAX_PRINT_HEIGHT = 2_000;
const PRINT_WIDTH = 384;

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function actionPaymentIntentId(action) {
  const paymentIntent = action?.process_payment_intent?.payment_intent;
  return typeof paymentIntent === "string" ? paymentIntent : paymentIntent?.id;
}

export class TerminalService {
  constructor(config, stripe = null, fetchImplementation = globalThis.fetch) {
    this.config = config;
    this.stripe = stripe || (config.stripeSecretKey ? new Stripe(config.stripeSecretKey) : null);
    this.fetch = fetchImplementation;
  }

  requireStripe() {
    if (!this.stripe || !this.config.stripeSecretKey) {
      throw new AppError("Stripe is not configured on this server.", {
        status: 503,
        code: "stripe_not_configured",
      });
    }
  }

  requestOptions(extra = {}) {
    return {
      ...(this.config.stripeConnectedAccountId
        ? { stripeAccount: this.config.stripeConnectedAccountId }
        : {}),
      ...extra,
    };
  }

  isPrintable(reader) {
    return reader?.device_type === "verifone_v660p";
  }

  async listPrinters() {
    this.requireStripe();
    const response = await this.stripe.terminal.readers.list(
      { limit: 100 },
      this.requestOptions(),
    );

    return response.data
      .filter((reader) => this.isPrintable(reader) && reader.status === "online")
      .map((reader) => ({
        id: reader.id,
        label: reader.label || null,
        serialNumber: reader.serial_number || null,
        status: reader.status,
        deviceType: reader.device_type,
        locationId:
          typeof reader.location === "string" ? reader.location : reader.location?.id || null,
      }))
      .sort((left, right) => (left.label || "").localeCompare(right.label || ""));
  }

  async retrieveUsablePrinter(readerId) {
    this.requireStripe();
    const reader = await this.stripe.terminal.readers.retrieve(
      readerId,
      {},
      this.requestOptions(),
    );

    if (!this.isPrintable(reader)) {
      throw new AppError("The selected terminal does not have a compatible printer.", {
        status: 409,
        code: "printer_not_supported",
      });
    }
    if (reader.status !== "online") {
      throw new AppError("The selected printer is offline.", {
        status: 409,
        code: "terminal_reader_offline",
      });
    }

    return reader;
  }

  async takePayment({ readerId, amount, quantity, discountApplied, idempotencyKey }) {
    const reader = await this.retrieveUsablePrinter(readerId);
    const paymentIntent = await this.stripe.paymentIntents.create(
      {
        amount,
        currency: this.config.currency,
        payment_method_types: ["card_present"],
        capture_method: "automatic_async",
        description: `${quantity} × House coffee${discountApplied ? " with smile discount" : ""}`,
        metadata: {
          smile_printer_reader_id: readerId,
          coffee_quantity: String(quantity),
          smile_discount: discountApplied ? String(this.config.discountPercentage) : "0",
        },
      },
      this.requestOptions({ idempotencyKey: `smile-printer:${idempotencyKey}:intent` }),
    );

    if (paymentIntent.status === "succeeded") {
      return paymentIntent;
    }

    if (paymentIntent.status === "processing") {
      return this.awaitPaymentIntent(paymentIntent.id);
    }

    const currentAction = reader.action;
    const actionIntentId = actionPaymentIntentId(currentAction);
    let submittedReader = reader;

    if (!(currentAction?.status === "in_progress" && actionIntentId === paymentIntent.id)) {
      submittedReader = await this.stripe.terminal.readers.processPaymentIntent(
        readerId,
        { payment_intent: paymentIntent.id },
        this.requestOptions(),
      );
    }

    try {
      await this.awaitReaderAction({
        readerId,
        initialReader: submittedReader,
        expectedType: "process_payment_intent",
        expectedPaymentIntentId: paymentIntent.id,
        attempts: this.config.paymentPollAttempts,
        intervalMs: this.config.paymentPollIntervalMs,
        timeoutMessage: "The payment terminal did not respond in time.",
      });
    } catch (error) {
      // These outcomes can occur after Stripe has already authorised the payment.
      if (!["connection_error", "payment_timeout"].includes(error?.code)) throw error;
    }

    return this.awaitPaymentIntent(paymentIntent.id);
  }

  async awaitPaymentIntent(paymentIntentId) {
    for (let attempt = 0; attempt < this.config.paymentPollAttempts; attempt += 1) {
      const intent = await this.stripe.paymentIntents.retrieve(
        paymentIntentId,
        {},
        this.requestOptions(),
      );

      if (intent.status === "succeeded") return intent;
      if (["canceled", "requires_payment_method"].includes(intent.status)) {
        throw new AppError(
          intent.last_payment_error?.message || "The payment was not completed.",
          {
            status: 402,
            code: intent.last_payment_error?.code || "payment_failed",
          },
        );
      }

      if (attempt < this.config.paymentPollAttempts - 1) {
        await wait(this.config.paymentPollIntervalMs);
      }
    }

    throw new AppError("The payment result could not be confirmed in time.", {
      status: 504,
      code: "payment_timeout",
    });
  }

  async assertPaidIntent(paymentIntentId, readerId) {
    this.requireStripe();
    const intent = await this.stripe.paymentIntents.retrieve(
      paymentIntentId,
      {},
      this.requestOptions(),
    );

    if (intent.status !== "succeeded") {
      throw new AppError("The receipt can only be printed after payment succeeds.", {
        status: 409,
        code: "payment_not_complete",
      });
    }
    if (intent.metadata?.smile_printer_reader_id !== readerId) {
      throw new AppError("The receipt printer does not match this payment.", {
        status: 409,
        code: "printer_mismatch",
      });
    }

    return intent;
  }

  async printReceipt({ readerId, paymentIntentId, imageDataUrl }) {
    await Promise.all([
      this.retrieveUsablePrinter(readerId),
      this.assertPaidIntent(paymentIntentId, readerId),
    ]);
    const image = await this.prepareReceipt(imageDataUrl);
    const submittedReader = await this.submitPrintContent(readerId, image);

    await this.awaitReaderAction({
      readerId,
      initialReader: submittedReader,
      expectedType: "print_content",
      attempts: this.config.printPollAttempts,
      intervalMs: this.config.printPollIntervalMs,
      timeoutMessage: "The printer did not report a result in time.",
    });

    return { status: "succeeded" };
  }

  async prepareReceipt(imageDataUrl) {
    const match = /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=]+)$/.exec(imageDataUrl || "");
    if (!match) {
      throw new AppError("The receipt must be a base64 PNG or JPEG image.", {
        status: 400,
        code: "invalid_receipt_image",
      });
    }

    const source = Buffer.from(match[2], "base64");
    if (source.length === 0 || source.length > MAX_SOURCE_IMAGE_BYTES) {
      throw new AppError("The receipt image is empty or too large.", {
        status: 413,
        code: "receipt_image_too_large",
      });
    }

    let output;
    try {
      const transformer = sharp(source, { limitInputPixels: MAX_SOURCE_PIXELS });
      const metadata = await transformer.metadata();
      const printedHeight = Math.round((metadata.height / metadata.width) * PRINT_WIDTH);
      if (!metadata.width || !metadata.height || printedHeight > MAX_PRINT_HEIGHT) {
        throw new AppError("The receipt image dimensions are not supported.", {
          status: 400,
          code: "invalid_receipt_image",
        });
      }

      output = await transformer
        .resize({ width: PRINT_WIDTH, withoutEnlargement: false })
        .flatten({ background: "white" })
        .grayscale()
        .threshold(190)
        .png({ palette: true, colours: 2, compressionLevel: 9 })
        .toBuffer();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("The receipt image could not be read.", {
        status: 400,
        code: "invalid_receipt_image",
        cause: error,
      });
    }

    if (output.length > MAX_STRIPE_IMAGE_BYTES) {
      throw new AppError("The optimized receipt is larger than Stripe’s 100KB limit.", {
        status: 413,
        code: "receipt_image_too_large",
      });
    }

    return output;
  }

  async submitPrintContent(readerId, image) {
    const form = new FormData();
    form.append("type", "image");
    form.append("image", new Blob([image], { type: "image/png" }), "receipt.png");

    const headers = {
      Authorization: `Basic ${Buffer.from(`${this.config.stripeSecretKey}:`).toString("base64")}`,
    };
    if (this.config.stripeConnectedAccountId) {
      headers["Stripe-Account"] = this.config.stripeConnectedAccountId;
    }

    const response = await this.fetch(
      `https://files.stripe.com/v1/terminal/readers/${encodeURIComponent(readerId)}/print_content`,
      { method: "POST", headers, body: form },
    );
    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new AppError(body?.error?.message || "Stripe rejected the print request.", {
        status: 502,
        code: body?.error?.code || "print_submission_failed",
      });
    }

    return body;
  }

  async awaitReaderAction({
    readerId,
    initialReader,
    expectedType,
    expectedPaymentIntentId = null,
    attempts,
    intervalMs,
    timeoutMessage,
  }) {
    let reader = initialReader;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const action = reader?.action;
      const actionMatches =
        action?.type === expectedType &&
        (!expectedPaymentIntentId ||
          actionPaymentIntentId(action) === expectedPaymentIntentId);

      if (actionMatches && action.status === "succeeded") return reader;
      if (actionMatches && action.status === "failed") {
        throw new AppError(action.failure_message || "The terminal could not complete the action.", {
          status: expectedType === "process_payment_intent" ? 402 : 409,
          code: action.failure_code || `${expectedType}_failed`,
        });
      }
      if (attempt === attempts - 1) break;

      await wait(intervalMs);
      reader = await this.stripe.terminal.readers.retrieve(
        readerId,
        {},
        this.requestOptions(),
      );
    }

    throw new AppError(timeoutMessage, {
      status: 504,
      code: expectedType === "print_content" ? "reason_unavailable" : "payment_timeout",
    });
  }
}
