interface Env {
  KV: KVNamespace;
  EMAIL: string;
  PASSWORD: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;

  // Optional non-secret vars (provide via [vars] if you want; fallback defaults below)
  TARGET_SITE_ID?: string;
  TARGET_MONTH_OFFSET?: string; // number as string, months ahead of current
  PERSONS?: string;
}

const BASE_URL = "https://ru.almaviva-visa.services";
const LOGIN_ENDPOINT = "/api/login";
const DISABLED_DATES_ENDPOINT = "/api/sites/disabled-dates/"; // expects query params

export default {
  // Manual fetch endpoint: shows last status info
  async fetch(_request: Request, env: Env): Promise<Response> {
    try {
      await runCheck(env); // allow on-demand check
    } catch (err) {
      // already notified inside runCheck
      console.error("Fetch-triggered runCheck error", err);
    }

    const status = await env.KV.get("Last");
    const lastAuth = await env.KV.get("Last_auth");
    const lastDates = await env.KV.get("Last_dates");

    const body =
      `Last check: ${status || "n/a"}\n` +
      `Last auth: ${lastAuth || "n/a"}\n` +
      `Last dates hash: ${lastDates || "n/a"}\n`;

    return new Response(body, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runCheck(env));
  }
};

/* ---------------- Core Orchestration ---------------- */

async function runCheck(env: Env) {
  try {
    const cookie = await ensureAuth(env);
    const { availableDates, monthRange } = await fetchAvailableDates(env, cookie);

    if (availableDates.length > 0) {
      await maybeNotifyNewDates(env, availableDates, monthRange);
      await resetFailureCount(env);
    } else {
      // Optionally: notify only when state changes; we already suppress duplicates
      await resetFailureCount(env);
      await env.KV.put("Last", `200:${timestamp()}`);
    }
  } catch (err: any) {
    console.error("runCheck error", err);
    await recordFailureAndMaybeNotify(env, err);
  }
}

/* ---------------- Authentication ---------------- */

interface AuthCookie {
  accessToken: string;
  [k: string]: any;
}

async function ensureAuth(env: Env): Promise<AuthCookie> {
  let cookie = await env.KV.get<AuthCookie>("Cookie", { type: "json" });
  if (!cookie) {
    cookie = await login(env);
  }
  return cookie;
}

async function login(env: Env): Promise<AuthCookie> {
  console.log("Authenticating...");
  const res = await fetch(`${BASE_URL}${LOGIN_ENDPOINT}`, {
    method: "POST",
    headers: {
      "Accept": "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "Authorization": "Bearer",
      "Origin": BASE_URL,
      "Referer": `${BASE_URL}/signin?returnUrl=%2Fappointment`
    },
    body: JSON.stringify({ email: env.EMAIL, password: env.PASSWORD })
  });

  if (!res.ok) {
    throw new Error(`Login failed: ${res.status} ${await res.text()}`);
  }
  const json = await res.json<AuthCookie>();
  await env.KV.put("Cookie", JSON.stringify(json), { expirationTtl: 8 * 60 * 60 }); // 8h
  await env.KV.put("Last_auth", timestamp());
  return json;
}

/* ---------------- Date Fetching & Parsing ---------------- */

interface MonthRange {
  startISO: string; // YYYY-MM-DD first day
  endISO: string;   // YYYY-MM-DD last day
  displayMonth: number; // 1-based month number
  displayYear: number;
}

async function fetchAvailableDates(env: Env, cookie: AuthCookie) {
  const siteId = env.TARGET_SITE_ID || "16";
  const persons = env.PERSONS || "1";

  // Month offset: 0 = current, 1 = next, etc.
  const monthOffset = parseInt(env.TARGET_MONTH_OFFSET || "0", 10);
  const range = calculateMonthRange(monthOffset);

  // The remote endpoint expects DD/MM/YYYY.
  const startParam = toDDMMYYYY(range.startISO);
  const endParam = toDDMMYYYY(range.endISO);

  const url = `${BASE_URL}${DISABLED_DATES_ENDPOINT}?start=${startParam}&end=${endParam}&siteId=${siteId}&persons=${persons}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Accept": "application/json, text/plain, */*",
      "Authorization": `Bearer ${cookie.accessToken}`,
      "Origin": BASE_URL,
      "Referer": `${BASE_URL}/appointment`,
      "Cookie": prepareCookie(cookie),
    }
  });

  if (res.status === 401 || res.status === 403) {
    // Token expired; refresh once
    console.log("Auth token expired, re-authenticating...");
    await env.KV.delete("Cookie");
    const newCookie = await login(env);
    return fetchAvailableDates(env, newCookie);
  }

  if (!res.ok) {
    await env.KV.put("Last", `${res.status}:${timestamp()}`);
    throw new Error(`Dates fetch failed: ${res.status}`);
  }

  await env.KV.put("Last", `200:${timestamp()}`);

  const disabledList = await res.json<any[]>();
  const availableDates = computeAvailableDays(disabledList, range);

  return { availableDates, monthRange: range };
}

function calculateMonthRange(offset: number): MonthRange {
  const now = new Date();
  // First day of target month
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  // Last day: first day of next month minus 1
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
  return {
    startISO: first.toISOString().slice(0, 10),
    endISO: last.toISOString().slice(0, 10),
    displayMonth: first.getUTCMonth() + 1,
    displayYear: first.getUTCFullYear()
  };
}

function computeAvailableDays(disabledDates: any[], range: MonthRange): string[] {
  // Build all dates in month
  const all: string[] = [];
  let d = new Date(range.startISO + "T00:00:00.000Z");
  const end = new Date(range.endISO + "T00:00:00.000Z");
  while (d <= end) {
    all.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }

  // Disabled list structure assumed: [{ date: "YYYY-MM-DD" }, ...] or maybe "2025-07-22T..."
  const disabledSet = new Set(
    disabledDates
      .map((x: any) => {
        if (!x.date) return null;
        const iso = x.date.substring(0, 10);
        return iso;
      })
      .filter(Boolean)
  );

  return all.filter(dateISO => !disabledSet.has(dateISO));
}

/* ---------------- Notification Logic ---------------- */

async function maybeNotifyNewDates(env: Env, dates: string[], range: MonthRange) {
  // Hash list to avoid spamming the same set
  const hash = await sha256Hex(dates.join(","));
  const lastHash = await env.KV.get("Last_dates");
  if (hash === lastHash) {
    console.log("Dates unchanged; notification suppressed.");
    return;
  }

  await env.KV.put("Last_dates", hash);

  const message = buildDatesMessage(dates, range);
  await sendTelegram(env, message);
}

function buildDatesMessage(dates: string[], range: MonthRange) {
  const header = `✅ Free dates for ${pad2(range.displayMonth)}/${range.displayYear}:`;
  const list = dates.slice(0, 15).map(d => `• ${d}`).join("\n");
  const extra = dates.length > 15 ? `\n…(+${dates.length - 15} more)` : "";
  return `${header}\n${list}${extra}`;
}

/* ----- Error / Failure Handling ----- */

async function recordFailureAndMaybeNotify(env: Env, err: any) {
  const failCountKey = "fail_count";
  const prev = parseInt((await env.KV.get(failCountKey)) || "0", 10);
  const current = prev + 1;
  await env.KV.put(failCountKey, current.toString());

  const msg = String(err instanceof Error ? err.message : err);

  // Deduplicate identical consecutive error message
  const lastErrMsg = await env.KV.get("last_error_msg");
  if (lastErrMsg !== msg) {
    await env.KV.put("last_error_msg", msg);
    await sendTelegram(env, `❗ Error: ${truncate(msg, 300)} (fail #${current})`);
  } else if (current === 3 || current === 5 || current % 10 === 0) {
    // Escalate on certain counts even if same message
    await sendTelegram(env, `⚠️ Still failing (${current} times): ${truncate(msg, 200)}`);
  }
}

async function resetFailureCount(env: Env) {
  await env.KV.put("fail_count", "0");
  await env.KV.delete("last_error_msg"); // So next distinct error not suppressed
}

/* ---------------- Telegram ---------------- */

async function sendTelegram(env: Env, text: string) {
  if (!text) return;

  // If you want a dry-run mode, you could add: if (env.DRY_RUN === "1") { console.log("[DRY RUN]", text); return; }

  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: env.TELEGRAM_CHAT_ID,
    text,
    // parse_mode: "MarkdownV2" // Avoid unless you escape; we send plain text
    disable_web_page_preview: true
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    console.error("Telegram send failed", res.status, await res.text());
  }
}

/* ---------------- Helpers ---------------- */

function prepareCookie(cookie: AuthCookie): string {
  const template: Record<string, any> = {
    "auth-token": cookie.accessToken,
    "auth-user": JSON.stringify(cookie),
    "cookie-consent": true
  };
  return objectToCookieString(template);
}

function objectToCookieString(obj: Record<string, any>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(v)));
  }
  return parts.join("; ");
}

function timestamp(): string {
  // Use Moscow time like original
  return new Date().toLocaleString("RU", { timeZone: "Europe/Moscow" });
}

function toDDMMYYYY(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

async function sha256Hex(data: string): Promise<string> {
  const enc = new TextEncoder().encode(data);
  const hashBuf = await crypto.subtle.digest("SHA-256", enc);
  return [...new Uint8Array(hashBuf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + "..." : s;
}
