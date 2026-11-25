// Telepathic billing logic. No runtime imports, so the same file runs in the Edge Function and in tests.
//
// Rules this file keeps:
//  - Stripe is the source of truth. Every subscription event re-reads the subscription from Stripe and stores
//    that state, so events arriving late, twice or out of order cannot leave the database wrong.
//  - Events are matched to an account through Stripe's own objects (customer -> our customer table).
//    Metadata is only a fallback.
//  - Access is never granted from the success page, only from webhook events.

// deno-lint-ignore-file no-explicit-any
export type Deps = {
  stripe: any | null;
  db: {
    customerFor(userId: string): Promise<string | null>;
    userForCustomer(customerId: string): Promise<string | null>;
    saveCustomer(userId: string, customerId: string): Promise<void>;
    getSubscription(userId: string): Promise<any | null>;
    saveSubscription(row: any): Promise<void>;
    setDisputed(userId: string, disputed: boolean): Promise<void>;
    logEvent(row: { id: string; user_id: string | null; type: string; detail: any }): Promise<void>;
  };
  auth: { deleteUser(userId: string): Promise<void> };
  cfg: { priceId: string; appUrl: string; trialDays: number; automaticTax: boolean };
};

export type Result = { status: number; body: any };

// Subscribe the Stripe webhook endpoint to exactly these.
export const WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
  'invoice.paid',
  'invoice.payment_failed',
  'charge.dispute.created',
  'charge.dispute.closed',
  'charge.refunded',
  'radar.early_fraud_warning.created',
];

const LIVE = ['active', 'trialing', 'past_due'];
const idOf = (v: any): string | null => (v == null ? null : typeof v === 'string' ? v : v.id ?? null);
const configured = (d: Deps) => !!(d.stripe && d.cfg.priceId && d.cfg.appUrl);

// ---------- actions called by the signed-in app ----------

export async function handleAction(action: string, user: { id: string; email?: string | null }, d: Deps): Promise<Result> {
  if (action === 'delete_account') return deleteAccount(user, d);
  if (!configured(d)) return { status: 503, body: { error: 'billing_not_configured' } };
  if (action === 'checkout') return checkout(user, d);
  if (action === 'portal') return portal(user, d);
  return { status: 400, body: { error: 'unknown_action' } };
}

async function checkout(user: { id: string; email?: string | null }, d: Deps): Promise<Result> {
  const existing = await d.db.getSubscription(user.id);
  // Already subscribed: send them to manage it instead of starting a second subscription.
  if (existing && LIVE.includes(existing.status)) return portal(user, d);

  let customer = await d.db.customerFor(user.id);
  if (!customer) {
    const created = await d.stripe.customers.create(
      { email: user.email ?? undefined, metadata: { user_id: user.id } },
      { idempotencyKey: `telepathic-customer-${user.id}` },
    );
    customer = created.id as string;
    await d.db.saveCustomer(user.id, customer);
  }

  const params: any = {
    mode: 'subscription',
    customer,
    client_reference_id: user.id,
    line_items: [{ price: d.cfg.priceId, quantity: 1 }],
    success_url: `${d.cfg.appUrl}?billing=done`,
    cancel_url: d.cfg.appUrl,
    allow_promotion_codes: true,
    integration_identifier: 'telepathic_plus_kqzvhwmt',
    subscription_data: { metadata: { user_id: user.id } },
  };
  // One free trial per account, ever.
  if (!existing && d.cfg.trialDays > 0) params.subscription_data.trial_period_days = d.cfg.trialDays;
  // Only switch this on after a tax registration is active in Stripe; otherwise Stripe silently collects nothing.
  if (d.cfg.automaticTax) {
    params.automatic_tax = { enabled: true };
    params.customer_update = { address: 'auto' };
  }
  const session = await d.stripe.checkout.sessions.create(params);
  return { status: 200, body: { url: session.url } };
}

async function portal(user: { id: string }, d: Deps): Promise<Result> {
  const customer = await d.db.customerFor(user.id);
  if (!customer) return { status: 400, body: { error: 'no_billing_account' } };
  const session = await d.stripe.billingPortal.sessions.create({ customer, return_url: d.cfg.appUrl });
  return { status: 200, body: { url: session.url } };
}

async function deleteAccount(user: { id: string }, d: Deps): Promise<Result> {
  const customer = await d.db.customerFor(user.id);
  if (customer) {
    // Never delete an account while leaving a subscription that keeps charging the card.
    if (!d.stripe) return { status: 503, body: { error: 'billing_not_configured' } };
    const subs = await d.stripe.subscriptions.list({ customer, status: 'all', limit: 100 });
    for (const sub of subs.data) {
      if (sub.status !== 'canceled' && sub.status !== 'incomplete_expired') await d.stripe.subscriptions.cancel(sub.id);
    }
  }
  await d.auth.deleteUser(user.id);
  return { status: 200, body: { ok: true } };
}

// ---------- Stripe webhook events (signature already verified by the caller) ----------

export async function handleEvent(event: any, d: Deps): Promise<void> {
  const obj = event.data.object;
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      if (obj.mode !== 'subscription') return;
      const customerId = idOf(obj.customer);
      if (customerId && obj.client_reference_id && !(await d.db.userForCustomer(customerId))) {
        await d.db.saveCustomer(obj.client_reference_id, customerId);
      }
      const subId = idOf(obj.subscription);
      if (subId) await syncSubscription(subId, d, event.id);
      return;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
    case 'customer.subscription.paused':
    case 'customer.subscription.resumed':
      await syncSubscription(obj.id, d, event.id);
      return;
    case 'invoice.paid':
    case 'invoice.payment_failed': {
      // Newer API versions nest the subscription under parent.subscription_details.
      const subId = idOf(obj.parent?.subscription_details?.subscription) ?? idOf(obj.subscription);
      if (subId) await syncSubscription(subId, d, event.id);
      return;
    }
    case 'charge.dispute.created':
    case 'charge.dispute.closed': {
      const charge = await d.stripe.charges.retrieve(idOf(obj.charge));
      const customerId = idOf(charge.customer);
      const userId = customerId ? await d.db.userForCustomer(customerId) : null;
      await d.db.logEvent({ id: event.id, user_id: userId, type: event.type, detail: { dispute: obj.id, charge: charge.id, status: obj.status, amount: obj.amount, reason: obj.reason } });
      if (!userId) return;
      // A dispute pauses sync. Winning it restores sync; any other outcome is left for a person to review.
      if (event.type === 'charge.dispute.created') await d.db.setDisputed(userId, true);
      else if (obj.status === 'won') await d.db.setDisputed(userId, false);
      return;
    }
    case 'charge.refunded': {
      const customerId = idOf(obj.customer);
      const userId = customerId ? await d.db.userForCustomer(customerId) : null;
      await d.db.logEvent({ id: event.id, user_id: userId, type: event.type, detail: { charge: obj.id, amount_refunded: obj.amount_refunded } });
      return;
    }
    case 'radar.early_fraud_warning.created': {
      const charge = await d.stripe.charges.retrieve(idOf(obj.charge));
      const customerId = idOf(charge.customer);
      const userId = customerId ? await d.db.userForCustomer(customerId) : null;
      await d.db.logEvent({ id: event.id, user_id: userId, type: event.type, detail: { warning: obj.id, charge: charge.id, fraud_type: obj.fraud_type } });
      return;
    }
    default:
      return;
  }
}

async function syncSubscription(subId: string, d: Deps, eventId: string): Promise<void> {
  const sub = await d.stripe.subscriptions.retrieve(subId);
  const customerId = idOf(sub.customer);
  let userId = customerId ? await d.db.userForCustomer(customerId) : null;
  if (!userId && customerId && sub.metadata?.user_id) {
    userId = sub.metadata.user_id as string;
    try { await d.db.saveCustomer(userId, customerId); } catch (_e) { userId = null; } // account no longer exists
  }
  if (!userId) {
    await d.db.logEvent({ id: eventId, user_id: null, type: 'unmatched_subscription', detail: { subscription: sub.id, customer: customerId } });
    return;
  }
  const current = await d.db.getSubscription(userId);
  // If an account somehow has two subscriptions, a dead one must not overwrite the live one.
  if (current && current.stripe_subscription_id && current.stripe_subscription_id !== sub.id && LIVE.includes(current.status) && !LIVE.includes(sub.status)) return;
  const item = sub.items?.data?.[0];
  const end = item?.current_period_end ?? sub.current_period_end ?? null;
  await d.db.saveSubscription({
    user_id: userId,
    stripe_subscription_id: sub.id,
    status: sub.status,
    price_id: item?.price?.id ?? null,
    current_period_end: end ? new Date(end * 1000).toISOString() : null,
    cancel_at_period_end: !!sub.cancel_at_period_end || !!sub.cancel_at,
    updated_at: new Date().toISOString(),
  });
}
