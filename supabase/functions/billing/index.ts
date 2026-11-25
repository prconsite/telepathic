// Telepathic billing Edge Function.
//   POST with a Stripe-Signature header -> Stripe webhook
//   POST with a signed-in user's token  -> { action: 'checkout' | 'portal' | 'delete_account' }
// Deploy with JWT verification off (Stripe cannot send a Supabase token); user calls are verified below.
//
// Secrets (Supabase dashboard -> Edge Functions -> Secrets):
//   STRIPE_API_KEY          restricted key (rk_...) with write access to Customers, Checkout Sessions,
//                           Customer portal and Subscriptions, and read access to Charges
//   STRIPE_WEBHOOK_SECRET   signing secret (whsec_...) of the webhook endpoint that points at this function
//   STRIPE_PRICE_ID         the recurring price of the Telepathic Plus product (price_...)
//   APP_URL                 where the app is hosted, e.g. https://prconsite.github.io/telepathic/
//   TRIAL_DAYS              optional, default 14; 0 for no trial
//   STRIPE_AUTOMATIC_TAX    optional, "true" only after a Stripe Tax registration is active
import Stripe from 'npm:stripe@23.2.0';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { type Deps, handleAction, handleEvent } from './core.ts';

const env = (k: string) => Deno.env.get(k) ?? '';
const appUrl = env('APP_URL');
const stripeKey = env('STRIPE_API_KEY');
const webhookSecret = env('STRIPE_WEBHOOK_SECRET');
// deno-lint-ignore no-explicit-any
const stripe: any = stripeKey ? new Stripe(stripeKey, { apiVersion: '2026-11-18.endive' as any, httpClient: Stripe.createFetchHttpClient() }) : null;
const admin = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });

// deno-lint-ignore no-explicit-any
const must = <T>(res: { data: T; error: any }): T => { if (res.error) throw new Error(res.error.message); return res.data; };

const deps: Deps = {
  stripe,
  cfg: { priceId: env('STRIPE_PRICE_ID'), appUrl, trialDays: Number(env('TRIAL_DAYS') || '14') || 0, automaticTax: env('STRIPE_AUTOMATIC_TAX') === 'true' },
  auth: {
    async deleteUser(userId) { const { error } = await admin.auth.admin.deleteUser(userId); if (error) throw new Error(error.message); },
  },
  db: {
    async customerFor(userId) { return must(await admin.from('tp_customers').select('stripe_customer_id').eq('user_id', userId).maybeSingle())?.stripe_customer_id ?? null; },
    async userForCustomer(customerId) { return must(await admin.from('tp_customers').select('user_id').eq('stripe_customer_id', customerId).maybeSingle())?.user_id ?? null; },
    async saveCustomer(userId, customerId) { must(await admin.from('tp_customers').upsert({ user_id: userId, stripe_customer_id: customerId }, { onConflict: 'user_id' })); },
    async getSubscription(userId) { return must(await admin.from('tp_subscriptions').select('*').eq('user_id', userId).maybeSingle()); },
    async saveSubscription(row) { must(await admin.from('tp_subscriptions').upsert(row, { onConflict: 'user_id' })); },
    async setDisputed(userId, disputed) { must(await admin.from('tp_subscriptions').update({ disputed, updated_at: new Date().toISOString() }).eq('user_id', userId)); },
    async logEvent(row) { must(await admin.from('tp_billing_events').upsert(row, { onConflict: 'id', ignoreDuplicates: true })); },
  },
};

let origin = '*';
try { if (appUrl) origin = new URL(appUrl).origin; } catch (_e) { /* keep * */ }
const cors = {
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin',
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  // ---- Stripe webhook ----
  const signature = req.headers.get('stripe-signature');
  if (signature) {
    if (!stripe || !webhookSecret) return json(503, { error: 'billing_not_configured' });
    let event;
    try {
      event = await stripe.webhooks.constructEventAsync(await req.text(), signature, webhookSecret, undefined, Stripe.createSubtleCryptoProvider());
    } catch (_e) {
      return json(400, { error: 'bad_signature' });
    }
    try {
      await handleEvent(event, deps);
      return json(200, { received: true });
    } catch (e) {
      console.error('webhook failed', event.type, event.id, e instanceof Error ? e.message : e);
      return json(500, { error: 'handler_failed' }); // Stripe retries
    }
  }

  // ---- signed-in app ----
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data, error } = token ? await admin.auth.getUser(token) : { data: null, error: new Error('no token') };
  if (error || !data?.user) return json(401, { error: 'not_signed_in' });
  let action = '';
  try { action = String((await req.json()).action ?? ''); } catch (_e) { /* empty body */ }
  try {
    const result = await handleAction(action, { id: data.user.id, email: data.user.email }, deps);
    return json(result.status, result.body);
  } catch (e) {
    console.error('billing action failed', action, e instanceof Error ? e.message : e);
    return json(502, { error: 'billing_unavailable' });
  }
});
