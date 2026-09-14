function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function readConfig(environment = process.env) {
  return {
    port: positiveInteger(environment.PORT, 3000),
    stripeSecretKey: environment.STRIPE_SECRET_KEY || "",
    stripeConnectedAccountId: environment.STRIPE_CONNECTED_ACCOUNT_ID || "",
    currency: (environment.STRIPE_CURRENCY || "eur").toLowerCase(),
    coffeePrice: positiveInteger(environment.COFFEE_PRICE, 430),
    discountPercentage: 10,
    paymentPollAttempts: positiveInteger(environment.PAYMENT_POLL_ATTEMPTS, 90),
    paymentPollIntervalMs: positiveInteger(environment.PAYMENT_POLL_INTERVAL_MS, 1000),
    printPollAttempts: positiveInteger(environment.PRINT_POLL_ATTEMPTS, 15),
    printPollIntervalMs: positiveInteger(environment.PRINT_POLL_INTERVAL_MS, 1000),
  };
}
