import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { AppError, publicError } from "./errors.js";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontendDirectory = path.join(rootDirectory, "frontend");
const mediaPipeDirectory = path.join(
  rootDirectory,
  "node_modules",
  "@mediapipe",
  "tasks-vision",
);

function requireObject(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AppError("A JSON request body is required.", {
      status: 400,
      code: "invalid_request",
    });
  }
}

function requireReaderId(readerId) {
  if (typeof readerId !== "string" || !/^tmr_[A-Za-z0-9_]+$/.test(readerId)) {
    throw new AppError("Select a valid Stripe Terminal reader.", {
      status: 400,
      code: "invalid_reader",
    });
  }
}

function validatePayment(body, config) {
  requireObject(body);
  requireReaderId(body.printerId);

  if (!Number.isInteger(body.quantity) || body.quantity < 1 || body.quantity > 20) {
    throw new AppError("Coffee quantity must be between 1 and 20.", {
      status: 400,
      code: "invalid_quantity",
    });
  }
  if (typeof body.discountApplied !== "boolean") {
    throw new AppError("Discount state must be true or false.", {
      status: 400,
      code: "invalid_discount",
    });
  }

  const subtotal = config.coffeePrice * body.quantity;
  const discount = body.discountApplied
    ? Math.round((subtotal * config.discountPercentage) / 100)
    : 0;

  return {
    readerId: body.printerId,
    quantity: body.quantity,
    discountApplied: body.discountApplied,
    amount: subtotal - discount,
  };
}

function validatePrint(body) {
  requireObject(body);
  requireReaderId(body.printerId);
  if (typeof body.paymentIntentId !== "string" || !body.paymentIntentId.startsWith("pi_")) {
    throw new AppError("A valid payment is required before printing.", {
      status: 400,
      code: "invalid_payment_intent",
    });
  }
  if (typeof body.imageDataUrl !== "string") {
    throw new AppError("A receipt image is required.", {
      status: 400,
      code: "invalid_receipt_image",
    });
  }

  return {
    readerId: body.printerId,
    paymentIntentId: body.paymentIntentId,
    imageDataUrl: body.imageDataUrl,
  };
}

export function createApp({ terminalService, config }) {
  const app = express();
  app.disable("x-powered-by");
  app.use((request, response, next) => {
    response.set({
      "Content-Security-Policy": [
        "default-src 'self'",
        "script-src 'self' 'wasm-unsafe-eval' https://cdn.jsdelivr.net",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src https://fonts.gstatic.com",
        "connect-src 'self' https://storage.googleapis.com",
        "img-src 'self' data:",
        "media-src 'self' blob:",
        "worker-src 'self' blob:",
      ].join("; "),
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Permissions-Policy": "camera=(self)",
      "Cache-Control": request.path.startsWith("/api/")
        ? "no-store"
        : request.path.startsWith("/vendor/mediapipe/")
          ? "public, max-age=31536000, immutable"
          : "no-cache",
    });
    next();
  });
  app.use(express.json({ limit: "4mb" }));

  app.get("/api/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.get("/api/config", (_request, response) => {
    response.json({
      unitPrice: config.coffeePrice,
      currency: config.currency,
      discountPercentage: config.discountPercentage,
    });
  });

  app.get("/api/printers", async (_request, response) => {
    response.json({ printers: await terminalService.listPrinters() });
  });

  app.post("/api/payments", async (request, response) => {
    const payment = validatePayment(request.body, config);
    const requestedKey = request.get("Idempotency-Key");
    const idempotencyKey =
      requestedKey && /^[A-Za-z0-9_.:-]{8,120}$/.test(requestedKey)
        ? requestedKey
        : crypto.randomUUID();
    const intent = await terminalService.takePayment({
      ...payment,
      idempotencyKey,
    });

    response.json({
      status: "succeeded",
      paymentIntentId: intent.id,
      amount: intent.amount,
      currency: intent.currency,
    });
  });

  app.post("/api/receipts/print", async (request, response) => {
    response.json(await terminalService.printReceipt(validatePrint(request.body)));
  });

  app.use(
    "/vendor/mediapipe",
    express.static(mediaPipeDirectory, {
      immutable: true,
      maxAge: "1y",
      fallthrough: false,
    }),
  );
  app.use(express.static(frontendDirectory, { extensions: ["html"] }));
  app.get("/{*path}", (_request, response) => {
    response.sendFile(path.join(frontendDirectory, "index.html"));
  });

  app.use((error, _request, response, _next) => {
    const safeError = publicError(error);
    if (safeError.status >= 500 && safeError.code !== "stripe_not_configured") console.error(error);
    response.status(safeError.status).json({
      message: safeError.message,
      code: safeError.code,
    });
  });

  return app;
}
