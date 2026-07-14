// TgFleet self-hosted sender worker
// Run: node worker.mjs
// Required env vars: API_BASE, WORKER_TOKEN, TG_API_ID, TG_API_HASH
// Optional: WORKER_LABEL (default "worker-1"), POLL_INTERVAL_MS (default 5000), HEARTBEAT_INTERVAL_MS (default 20000)

import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const API_BASE = process.env.API_BASE;
const TOKEN = process.env.WORKER_TOKEN;
const API_ID = Number(process.env.TG_API_ID);
const API_HASH = process.env.TG_API_HASH;
const LABEL = process.env.WORKER_LABEL || "worker-1";
const POLL_MS = Number(process.env.POLL_INTERVAL_MS || 5000);
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_INTERVAL_MS || 20000);
const VERSION = "0.2.0";

if (!API_BASE || !TOKEN || !API_ID || !API_HASH) {
  console.error("[fatal] Missing env vars. Required: API_BASE, WORKER_TOKEN, TG_API_ID, TG_API_HASH");
  process.exit(1);
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function api(path, body) {
  const url = API_BASE.replace(/\/$/, "") + path;
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-worker-token": TOKEN },
    body: JSON.stringify(body ?? {}),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`${path} → ${r.status} ${text}`);
  }
  return r.json();
}

const clients = new Map(); // account_id -> TelegramClient

async function ensureClient(acct, session) {
  if (clients.has(acct.id)) return clients.get(acct.id);
  const c = new TelegramClient(new StringSession(session ?? ""), API_ID, API_HASH, {
    connectionRetries: 5,
    useWSS: true,
  });
  await c.connect();
  clients.set(acct.id, c);
  return c;
}

async function handleLogin(acct, ch) {
  const c = await ensureClient(acct, null);
  try {
    if (ch.stage === "code" && !ch.phone_code_hash) {
      const { phoneCodeHash } = await c.sendCode({ apiId: API_ID, apiHash: API_HASH }, acct.phone);
      await api("/api/public/worker/report", {
        type: "login_code_sent",
        challenge_id: ch.id,
        phone_code_hash: phoneCodeHash,
      });
      log("[login] code sent to", acct.phone);
      return;
    }
    if (ch.stage === "code" && ch.submitted_code && ch.phone_code_hash) {
      try {
        await c.invoke(new Api.auth.SignIn({
          phoneNumber: acct.phone,
          phoneCodeHash: ch.phone_code_hash,
          phoneCode: ch.submitted_code,
        }));
        const session = c.session.save();
        await api("/api/public/worker/report", {
          type: "login_complete",
          challenge_id: ch.id,
          account_id: acct.id,
          session,
        });
        log("[login] complete for", acct.phone);
      } catch (e) {
        const msg = String(e?.message || e);
        if (msg.includes("SESSION_PASSWORD_NEEDED")) {
          await api("/api/public/worker/report", { type: "need_password", challenge_id: ch.id });
          log("[login] 2FA needed for", acct.phone);
        } else {
          throw e;
        }
      }
      return;
    }
    if (ch.stage === "password" && ch.submitted_password) {
      await c.signInWithPassword(
        { apiId: API_ID, apiHash: API_HASH },
        {
          password: async () => ch.submitted_password,
          onError: (e) => {
            throw e;
          },
        },
      );
      const session = c.session.save();
      await api("/api/public/worker/report", {
        type: "login_complete",
        challenge_id: ch.id,
        account_id: acct.id,
        session,
      });
      log("[login] 2FA complete for", acct.phone);
    }
  } catch (e) {
    const err = String(e?.message || e);
    log("[login] error", acct.phone, err);
    await api("/api/public/worker/report", {
      type: "login_error",
      challenge_id: ch.id,
      account_id: acct.id,
      error: err,
    }).catch(() => {});
    clients.delete(acct.id);
  }
}

async function handleSyncGroups(acct) {
  try {
    const c = await ensureClient(acct, acct.session);
    const dialogs = await c.getDialogs({ limit: 500 });
    const groups = dialogs
      .filter((d) => d.isGroup || d.isChannel)
      .map((d) => ({
        tg_chat_id: String(d.id),
        title: d.title || "(untitled)",
        member_count: d.entity?.participantsCount ?? null,
        is_broadcast: !!d.entity?.broadcast,
        is_admin: !!d.entity?.creator || !!d.entity?.adminRights,
      }));
    await api("/api/public/worker/report", { type: "groups", account_id: acct.id, groups });
    log("[sync]", acct.label || acct.phone, "→", groups.length, "groups");
  } catch (e) {
    log("[sync] error", acct.id, String(e?.message || e));
  }
}

async function handleSend(job, acct, group) {
  try {
    const c = await ensureClient(acct, acct.session);
    await c.sendMessage(group.tg_chat_id, { message: job.rendered_body });
    await api("/api/public/worker/report", { type: "send_result", job_id: job.id, ok: true });
    log("[send] ok →", group.title);
  } catch (e) {
    const s = String(e?.message || e);
    const m = s.match(/FLOOD_WAIT_(\d+)/);
    if (m) {
      await api("/api/public/worker/report", {
        type: "send_result",
        job_id: job.id,
        ok: false,
        flood_wait_seconds: Number(m[1]),
        error: s,
      });
      log("[send] FLOOD_WAIT", m[1], "s →", group.title);
    } else {
      await api("/api/public/worker/report", { type: "send_result", job_id: job.id, ok: false, error: s });
      log("[send] fail →", group.title, s);
    }
  }
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const { logins = [], syncs = [], sends = [] } = await api("/api/public/worker/poll", {});
    for (const { account, challenge } of logins) await handleLogin(account, challenge);
    for (const acct of syncs) await handleSyncGroups(acct);
    for (const { job, account, group } of sends) await handleSend(job, account, group);
  } catch (e) {
    log("[tick] error", String(e?.message || e));
  } finally {
    ticking = false;
  }
}

async function heartbeat() {
  try {
    await api("/api/public/worker/heartbeat", { worker_label: LABEL, version: VERSION });
  } catch (e) {
    log("[heartbeat] error", String(e?.message || e));
  }
}

process.on("SIGINT", () => {
  log("shutting down");
  process.exit(0);
});
process.on("SIGTERM", () => {
  log("shutting down");
  process.exit(0);
});

log(`TgFleet worker "${LABEL}" v${VERSION} → ${API_BASE}`);
heartbeat();
setInterval(heartbeat, HEARTBEAT_MS);
setInterval(tick, POLL_MS);
