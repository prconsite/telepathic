// Public client configuration. The publishable key is designed to ship in the browser:
// every table is locked by row-level security and is reachable only through the tp_* functions.
const override = (typeof window !== 'undefined' && window.__TP_CONFIG__) || {};
export const CONFIG = {
  supabaseUrl: 'https://mogdimbxcxkoeotfssgk.supabase.co',
  supabaseKey: 'sb_publishable_xN2Nj1JdRWSfwvkySL3eRA_eEHorTEv',
  version: '1.2.0',
  pairing: true,  // also offer pairing-code sync for people who do not want an account
  preview: false, // true only for the sandboxed preview build, where the network, camera and microphone are blocked
  ...override,
};
