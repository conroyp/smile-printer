import assert from "node:assert/strict";
import { describe, it } from "node:test";
import sharp from "sharp";
import { TerminalService } from "../server/terminal-service.js";

function serviceConfig(overrides = {}) {
  return {
    stripeSecretKey: "sk_test_example",
    stripeConnectedAccountId: "",
    currency: "eur",
    discountPercentage: 10,
    paymentPollAttempts: 2,
    paymentPollIntervalMs: 1,
    printPollAttempts: 2,
    printPollIntervalMs: 1,
    ...overrides,
  };
}

describe("TerminalService", () => {
  it("returns only online V660p readers", async () => {
    const stripe = {
      terminal: {
        readers: {
          async list() {
            return {
              data: [
                {
                  id: "tmr_online",
                  device_type: "verifone_v660p",
                  status: "online",
                  label: "Front counter",
                  serial_number: "ABC",
                  location: "tml_one",
                },
                { id: "tmr_offline", device_type: "verifone_v660p", status: "offline" },
                { id: "tmr_s700", device_type: "stripe_s700", status: "online" },
              ],
            };
          },
        },
      },
    };
    const service = new TerminalService(serviceConfig(), stripe);

    assert.deepEqual(await service.listPrinters(), [
      {
        id: "tmr_online",
        label: "Front counter",
        serialNumber: "ABC",
        status: "online",
        deviceType: "verifone_v660p",
        locationId: "tml_one",
      },
    ]);
  });

  it("waits for both the reader action and PaymentIntent success", async () => {
    let readerRetrievals = 0;
    let processedIntent = null;
    const stripe = {
      terminal: {
        readers: {
          async retrieve() {
            readerRetrievals += 1;
            if (readerRetrievals === 1) {
              return {
                id: "tmr_v660p",
                device_type: "verifone_v660p",
                status: "online",
                action: null,
              };
            }
            return {
              id: "tmr_v660p",
              device_type: "verifone_v660p",
              status: "online",
              action: {
                type: "process_payment_intent",
                status: "succeeded",
                process_payment_intent: { payment_intent: "pi_example" },
              },
            };
          },
          async processPaymentIntent(_readerId, params) {
            processedIntent = params.payment_intent;
            return {
              action: {
                type: "process_payment_intent",
                status: "in_progress",
                process_payment_intent: { payment_intent: "pi_example" },
              },
            };
          },
        },
      },
      paymentIntents: {
        async create() {
          return { id: "pi_example", status: "requires_payment_method" };
        },
        async retrieve() {
          return { id: "pi_example", status: "succeeded", amount: 765, currency: "eur" };
        },
      },
    };
    const service = new TerminalService(serviceConfig(), stripe);
    const intent = await service.takePayment({
      readerId: "tmr_v660p",
      amount: 765,
      quantity: 2,
      discountApplied: true,
      idempotencyKey: "test-key",
    });

    assert.equal(processedIntent, "pi_example");
    assert.equal(intent.status, "succeeded");
  });

  it("checks the PaymentIntent after an ambiguous reader connection error", async () => {
    const stripe = {
      terminal: {
        readers: {
          async retrieve() {
            return { id: "tmr_v660p", device_type: "verifone_v660p", status: "online" };
          },
          async processPaymentIntent() {
            return {
              action: {
                type: "process_payment_intent",
                status: "failed",
                failure_code: "connection_error",
                process_payment_intent: { payment_intent: "pi_example" },
              },
            };
          },
        },
      },
      paymentIntents: {
        async create() {
          return { id: "pi_example", status: "requires_payment_method" };
        },
        async retrieve() {
          return { id: "pi_example", status: "succeeded", amount: 765, currency: "eur" };
        },
      },
    };
    const service = new TerminalService(serviceConfig(), stripe);

    const intent = await service.takePayment({
      readerId: "tmr_v660p",
      amount: 765,
      quantity: 2,
      discountApplied: true,
      idempotencyKey: "test-key",
    });

    assert.equal(intent.status, "succeeded");
  });

  it("checks the PaymentIntent after reader polling times out", async () => {
    const stripe = {
      terminal: {
        readers: {
          async retrieve() {
            return { id: "tmr_v660p", device_type: "verifone_v660p", status: "online" };
          },
          async processPaymentIntent() {
            return {
              action: {
                type: "process_payment_intent",
                status: "in_progress",
                process_payment_intent: { payment_intent: "pi_example" },
              },
            };
          },
        },
      },
      paymentIntents: {
        async create() {
          return { id: "pi_example", status: "requires_payment_method" };
        },
        async retrieve() {
          return { id: "pi_example", status: "succeeded", amount: 765, currency: "eur" };
        },
      },
    };
    const service = new TerminalService(serviceConfig({ paymentPollAttempts: 1 }), stripe);

    const intent = await service.takePayment({
      readerId: "tmr_v660p",
      amount: 765,
      quantity: 2,
      discountApplied: true,
      idempotencyKey: "test-key",
    });

    assert.equal(intent.status, "succeeded");
  });

  it("converts a browser image into a 384px, two-colour PNG", async () => {
    const source = await sharp({
      create: {
        width: 160,
        height: 100,
        channels: 4,
        background: { r: 50, g: 120, b: 200, alpha: 0.5 },
      },
    })
      .png()
      .toBuffer();
    const service = new TerminalService(serviceConfig(), {});
    const output = await service.prepareReceipt(`data:image/png;base64,${source.toString("base64")}`);
    const metadata = await sharp(output).metadata();
    const { channels } = await sharp(output).stats();

    assert.equal(metadata.format, "png");
    assert.equal(metadata.width, 384);
    assert.ok(output.length <= 100 * 1024);
    assert.ok(channels.every((channel) => channel.min === channel.max));
  });

  it("prints only after confirming the paid intent belongs to the reader", async () => {
    let readerRetrievals = 0;
    let uploadedBytes = 0;
    const source = await sharp({
      create: {
        width: 384,
        height: 120,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .png()
      .toBuffer();
    const stripe = {
      terminal: {
        readers: {
          async retrieve() {
            readerRetrievals += 1;
            return {
              id: "tmr_v660p",
              device_type: "verifone_v660p",
              status: "online",
              action:
                readerRetrievals > 1
                  ? { type: "print_content", status: "succeeded" }
                  : null,
            };
          },
        },
      },
      paymentIntents: {
        async retrieve() {
          return {
            id: "pi_paid",
            status: "succeeded",
            metadata: { smile_printer_reader_id: "tmr_v660p" },
          };
        },
      },
    };
    const fetchImplementation = async (url, options) => {
      assert.match(url, /tmr_v660p\/print_content$/);
      assert.match(options.headers.Authorization, /^Basic /);
      assert.equal(options.body.get("type"), "image");
      uploadedBytes = (await options.body.get("image").arrayBuffer()).byteLength;
      return new Response(
        JSON.stringify({ action: { type: "print_content", status: "in_progress" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const service = new TerminalService(serviceConfig(), stripe, fetchImplementation);
    const result = await service.printReceipt({
      readerId: "tmr_v660p",
      paymentIntentId: "pi_paid",
      imageDataUrl: `data:image/png;base64,${source.toString("base64")}`,
    });

    assert.deepEqual(result, { status: "succeeded" });
    assert.ok(uploadedBytes > 0 && uploadedBytes <= 100 * 1024);
  });

  it("preserves V660p failure codes for an operator-friendly message", async () => {
    const service = new TerminalService(serviceConfig(), {});

    await assert.rejects(
      service.awaitReaderAction({
        readerId: "tmr_v660p",
        initialReader: {
          action: {
            type: "print_content",
            status: "failed",
            failure_code: "reason_out_of_paper",
            failure_message: "The printer is out of paper.",
          },
        },
        expectedType: "print_content",
        attempts: 1,
        intervalMs: 1,
        timeoutMessage: "Timed out.",
      }),
      (error) => error.code === "reason_out_of_paper" && error.status === 409,
    );
  });
});
