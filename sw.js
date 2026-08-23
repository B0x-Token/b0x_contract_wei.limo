// Service Worker that resolves every same-origin request against the
// B0xWebsiteFrontend contract on Optimism (EIP-5219 request(path)),
// the same way a server-side web3:// gateway (w3eth.io, w3link.io) does —
// except entirely client-side, with no gateway server involved.
//
// Two upgrades over the basic version:
//  1. RPC calls prefer a connected browser wallet (via the page-side bridge
//     script injected into the served HTML) and only fall back to public
//     RPC endpoints if no wallet is connected or the relay fails/times out.
//  2. Every resolve is batched through Multicall3's aggregate3() instead of
//     firing one eth_call per asset — a page with 30 assets becomes 1 RPC
//     round trip instead of 30.

importScripts('./abi-codec.js');

const CONTRACT_ADDRESS = '0x0000000000B28e06c885024Db22265b2536b24CC';
const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
const RPC_URLS = [
  'https://mainnet.optimism.io',
  'https://optimism.publicnode.com',
];
const BATCH_WINDOW_MS = 20;
const WALLET_RELAY_TIMEOUT_MS = 8000;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// ---- wallet relay bridge (talks to the page-side script injected into HTML) ----

let walletAvailable = false;
let customRpcUrl = null;
const pendingRelays = new Map();
let relayCounter = 0;

self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg) return;

  if (msg.type === 'WALLET_STATUS') {
    walletAvailable = !!msg.connected;
    return;
  }

  if (msg.type === 'CUSTOM_RPC') {
    customRpcUrl = msg.url || null;
    return;
  }

  if (msg.type === 'RPC_RELAY_RESULT') {
    const pending = pendingRelays.get(msg.id);
    if (!pending) return;
    pendingRelays.delete(msg.id);
    if (msg.error) pending.reject(new Error(msg.error));
    else pending.resolve(msg.result);
  }
});

async function relayViaWallet(to, calldata) {
  if (!walletAvailable) throw new Error('no wallet connected');
  const clients = await self.clients.matchAll({ type: 'window' });
  if (!clients.length) throw new Error('no client available to relay through');

  const id = ++relayCounter;
  const resultPromise = new Promise((resolve, reject) => {
    pendingRelays.set(id, { resolve, reject });
    setTimeout(() => {
      if (pendingRelays.has(id)) {
        pendingRelays.delete(id);
        reject(new Error('wallet relay timed out'));
      }
    }, WALLET_RELAY_TIMEOUT_MS);
  });

  clients[0].postMessage({
    type: 'RPC_RELAY',
    id,
    method: 'eth_call',
    params: [{ to, data: calldata }, 'latest'],
  });

  return resultPromise;
}

async function ethCallPublic(to, calldata) {
  const urls = customRpcUrl ? [customRpcUrl, ...RPC_URLS] : RPC_URLS;
  let lastErr;
  for (const rpc of urls) {
    try {
      const res = await fetch(rpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_call',
          params: [{ to, data: calldata }, 'latest'],
        }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error.message || 'eth_call reverted');
      return json.result;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function ethCall(to, calldata) {
  if (walletAvailable) {
    try {
      return await relayViaWallet(to, calldata);
    } catch (e) {
      // fall through to public RPC below
    }
  }
  return ethCallPublic(to, calldata);
}

// ---- batching every resolve through Multicall3.aggregate3 ----

let pendingBatch = [];
let flushScheduled = false;

function resolveOnChain(pathname) {
  const segments = pathname.replace(/^\//, '').split('/').filter(Boolean);
  return new Promise((resolve, reject) => {
    pendingBatch.push({ segments, resolve, reject });
    if (!flushScheduled) {
      flushScheduled = true;
      setTimeout(flushBatch, BATCH_WINDOW_MS);
    }
  });
}

async function flushBatch() {
  const batch = pendingBatch;
  pendingBatch = [];
  flushScheduled = false;

  const calls = batch.map((item) => ({
    target: CONTRACT_ADDRESS,
    allowFailure: true,
    callData: self.B0xResolver.encodeRequest(item.segments),
  }));

  let results;
  try {
    const calldata = self.B0xResolver.encodeAggregate3(calls);
    const raw = await ethCall(MULTICALL3_ADDRESS, calldata);
    results = self.B0xResolver.decodeAggregate3(raw);
  } catch (e) {
    batch.forEach((item) => item.reject(e));
    return;
  }

  batch.forEach((item, i) => {
    const r = results[i];
    if (!r || !r.success) {
      item.reject(new Error('call failed for /' + item.segments.join('/')));
      return;
    }
    try {
      item.resolve(self.B0xResolver.decodeResponse(r.returnData));
    } catch (e) {
      item.reject(e);
    }
  });
}

// ---- bridge script injected into the served HTML so the page can relay
//      eth_call requests through the visitor's own connected wallet ----
//
// No visible UI here on purpose — the "Connect Wallet" decision happens
// once, up front, on the resolver's own bootstrap screen (index.html).
// If the visitor connected there, the wallet extension already remembers
// this origin, so window.ethereum.selectedAddress is populated again as
// soon as this page loads and the bridge silently reports it to the SW.

const BRIDGE_SCRIPT = `<script>(function(){
var SW = navigator.serviceWorker;
if (!SW) return;
var connected = !!(window.ethereum && window.ethereum.selectedAddress);

function tellStatus(){
  if (!SW.controller) return;
  SW.controller.postMessage({type:'WALLET_STATUS', connected: connected});
  try {
    var savedRpc = localStorage.getItem('b0x_custom_rpc');
    if (savedRpc) SW.controller.postMessage({type:'CUSTOM_RPC', url: savedRpc});
  } catch (e) { /* localStorage unavailable — skip */ }
}

SW.addEventListener('message', function(event){
  var msg = event.data;
  if (!msg || msg.type !== 'RPC_RELAY') return;
  if (!window.ethereum) {
    SW.controller && SW.controller.postMessage({type:'RPC_RELAY_RESULT', id: msg.id, error: 'no wallet'});
    return;
  }
  window.ethereum.request({ method: msg.method, params: msg.params }).then(function(result){
    SW.controller && SW.controller.postMessage({type:'RPC_RELAY_RESULT', id: msg.id, result: result});
  }).catch(function(e){
    SW.controller && SW.controller.postMessage({type:'RPC_RELAY_RESULT', id: msg.id, error: (e && e.message) || String(e)});
  });
});

if (window.ethereum && window.ethereum.on) {
  window.ethereum.on('accountsChanged', function(accounts){
    connected = !!(accounts && accounts.length > 0);
    tellStatus();
  });
}

tellStatus();
})();</script>`;

function injectBridge(html) {
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (match) => match + BRIDGE_SCRIPT);
  }
  return BRIDGE_SCRIPT + html;
}

// ---- fetch handling ----

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (url.origin !== self.location.origin || event.request.method !== 'GET') {
    return;
  }

  // Full-page navigations (address bar loads, reloads, bookmarks) fall
  // through to the real network by default, so the actual bootstrap
  // index.html — with its Connect Wallet / Continue without wallet screen
  // and 10s countdown — always loads fresh, every visit, even once the
  // wallet is already approved for this origin and this worker is already
  // registered and active. The one exception is the bootstrap page's own
  // handoff navigation once the countdown finishes, marked with
  // ?__b0x_go=1 — that one *is* resolved on-chain below, same as any
  // sub-resource request the resolved page itself makes.
  if (event.request.mode === 'navigate' && !url.searchParams.has('__b0x_go')) {
    return;
  }

  if (url.searchParams.has('__b0x_rpc')) {
    customRpcUrl = url.searchParams.get('__b0x_rpc') || null;
  }

  event.respondWith((async () => {
    try {
      const { statusCode, bodyBytes, headers } = await resolveOnChain(url.pathname);
      const responseHeaders = new Headers();
      for (const { key, value } of headers) responseHeaders.set(key, value);

      const isHtml = (responseHeaders.get('content-type') || '').includes('text/html');
      let responseBody = bodyBytes;
      if (isHtml) {
        const html = new TextDecoder().decode(bodyBytes);
        responseBody = new TextEncoder().encode(injectBridge(html));
      }

      return new Response(responseBody, {
        status: statusCode || 200,
        headers: responseHeaders,
      });
    } catch (e) {
      return new Response(
        'On-chain resolve failed for ' + url.pathname + ': ' + e.message,
        { status: 502, headers: { 'content-type': 'text/plain' } }
      );
    }
  })());
});
