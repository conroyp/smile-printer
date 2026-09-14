import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createApp } from "../server/app.js";

const calls = [];
const terminalService = {
  async listPrinters() {
    return [
      {
        id: "tmr_v660p",
        label: "Counter",
        serialNumber: "V660P-123",
        status: "online",
        deviceType: "verifone_v660p",
        locationId: "tml_shop",
      },
    ];
  },
  async takePayment(input) {
    calls.push(["payment", input]);
    return { id: "pi_paid", amount: input.amount, currency: "eur", status: "succeeded" };
  },
  async printReceipt(input) {
    calls.push(["print", input]);
    return { status: "succeeded" };
  },
};
const config = {
  coffeePrice: 430,
  currency: "eur",
  discountPercentage: 10,
};

describe("HTTP API", () => {
  let server;
  let origin;

  before(() => {
    server = createApp({ terminalService, config }).listen(0);
    origin = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  it("publishes only safe shop configuration", async () => {
    const response = await fetch(`${origin}/api/config`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      unitPrice: 430,
      currency: "eur",
      discountPercentage: 10,
    });
  });

  it("lists available printer data", async () => {
    const response = await fetch(`${origin}/api/printers`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.printers[0].id, "tmr_v660p");
  });

  it("serves the worker and cacheable local MediaPipe runtime", async () => {
    const workerResponse = await fetch(`${origin}/face-landmarker.worker.js`);
    const runtimeResponse = await fetch(`${origin}/vendor/mediapipe/vision_bundle.js`);

    assert.equal(workerResponse.status, 200);
    assert.match(await workerResponse.text(), /detectForVideo/);
    assert.equal(runtimeResponse.status, 200);
    assert.equal(runtimeResponse.headers.get("cache-control"), "public, max-age=31536000, immutable");
    await runtimeResponse.body.cancel();
  });

  it("calculates the discounted charge on the server", async () => {
    const response = await fetch(`${origin}/api/payments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "checkout-test-123",
      },
      body: JSON.stringify({
        printerId: "tmr_v660p",
        quantity: 2,
        discountApplied: true,
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.amount, 774);
    assert.equal(calls.at(-1)[0], "payment");
    assert.equal(calls.at(-1)[1].amount, 774);
  });

  it("rejects invalid quantities before calling Stripe", async () => {
    const callCount = calls.length;
    const response = await fetch(`${origin}/api/payments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        printerId: "tmr_v660p",
        quantity: 0,
        discountApplied: false,
      }),
    });

    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "invalid_quantity");
    assert.equal(calls.length, callCount);
  });

  it("passes a paid receipt to the print service", async () => {
    const imageDataUrl = "data:image/png;base64,iVBORw0KGgo=";
    const response = await fetch(`${origin}/api/receipts/print`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        printerId: "tmr_v660p",
        paymentIntentId: "pi_paid",
        imageDataUrl,
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "succeeded" });
    assert.equal(calls.at(-1)[0], "print");
    assert.equal(calls.at(-1)[1].imageDataUrl, imageDataUrl);
  });
});
