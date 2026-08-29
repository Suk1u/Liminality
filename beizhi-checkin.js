/*
 * Beizhi / New API daily check-in for Surge.
 * Cookie format: account name:::cookie|||another name:::cookie
 */
const BASE_URL = "https://beizhi.sylu.cc";
const COOKIE_KEY = "beizhi_sylu_checkin_cookies";
const COOKIE_CAPTURED_KEY = "beizhi_sylu_checkin_captured";
const COOKIE_UA_KEY = "beizhi_sylu_checkin_ua";
const COOKIE_NOTICE_KEY = "beizhi_sylu_checkin_notice";
const QUOTA_PER_UNIT = 500000;
const CURRENCY_SYMBOL = "🍊";
const DEFAULT_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";

function getArgument(name) {
  const raw = typeof $argument === "string" ? $argument : "";
  const match = raw.match(new RegExp("(?:^|&)" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=([^&]*)"));
  if (!match) return "";
  try { return decodeURIComponent(match[1].replace(/\+/g, " ")); } catch (_) { return match[1]; }
}

function readJSON(key, fallback) {
  const raw = $persistentStore.read(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch (_) { return fallback; }
}

function writeJSON(key, value) {
  return $persistentStore.write(JSON.stringify(value), key);
}

function notify(title, subtitle, body, enabled) {
  if (enabled === false) return;
  try { $notification.post(title, subtitle || "", body || ""); }
  catch (error) { console.log("[Beizhi] 通知失败：" + error); }
}

function notifyOnce(key, title, subtitle, body, enabled) {
  const last = readJSON(COOKIE_NOTICE_KEY, {});
  const now = Date.now();
  if (last[key] && now - last[key] < 10000) return;
  last[key] = now;
  writeJSON(COOKIE_NOTICE_KEY, last);
  notify(title, subtitle, body, enabled);
}

function headerValue(headers, wanted) {
  if (!headers) return "";
  const key = Object.keys(headers).find(k => k.toLowerCase() === wanted.toLowerCase());
  return key ? String(headers[key] || "") : "";
}

function parseAccounts(raw) {
  if (!raw) return [];
  const text = String(raw).trim();
  if (!text) return [];

  let parsed;
  if (text[0] === "[") {
    try { parsed = JSON.parse(text); } catch (_) { parsed = null; }
  }
  if (Array.isArray(parsed)) {
    return parsed.map((item, index) => ({
      name: String(item.name || item.username || ("账号" + (index + 1))),
      cookie: String(item.cookie || "").trim()
    })).filter(item => item.cookie);
  }

  return text.split("|||").map((item, index) => {
    const split = item.indexOf(":::");
    if (split < 0) return { name: "账号" + (index + 1), cookie: item.trim() };
    return { name: item.slice(0, split).trim() || ("账号" + (index + 1)), cookie: item.slice(split + 3).trim() };
  }).filter(item => item.cookie);
}

function mergeAccounts(configured, stored) {
  const result = [];
  const seen = {};
  configured.concat(stored).forEach(item => {
    if (!item.cookie || seen[item.cookie]) return;
    seen[item.cookie] = true;
    result.push(item);
  });
  return result;
}

function parseBody(body) {
  if (!body) return {};
  try { return JSON.parse(body); } catch (_) { return { message: String(body).slice(0, 160) }; }
}

function apiMessage(payload, fallback) {
  return String(payload && (payload.message || payload.error?.message || payload.data?.message || payload.code) || fallback || "未知响应");
}

function request(method, url, headers, policy, body) {
  return new Promise(resolve => {
    const options = {
      url,
      headers,
      timeout: 10,
      policy: policy || "DIRECT",
      "auto-cookie": false,
      "auto-redirect": true
    };
    if (body !== undefined) options.body = body;
    const callback = (error, response, data) => resolve({ error, response: response || {}, data: data || "" });
    if (method === "POST") $httpClient.post(options, callback);
    else $httpClient.get(options, callback);
  });
}

function accountHeaders(cookie, token, userAgent) {
  const headers = {
    "User-Agent": userAgent || DEFAULT_UA,
    "Accept": "application/json, text/plain, */*",
    "Origin": BASE_URL,
    "Referer": BASE_URL + "/profile",
    "Content-Type": "application/json"
  };
  if (cookie) headers.Cookie = cookie;
  if (token) headers.Authorization = "Bearer " + token;
  return headers;
}

function extractToken(payload) {
  const data = payload && payload.data;
  return String((data && (data.access_token || data.accessToken)) || payload.access_token || payload.accessToken || "");
}

function extractUser(payload) {
  const value = payload && payload.data;
  return value && value.user ? value.user : (value || payload || {});
}

function formatNumber(value) {
  if (value === undefined || value === null || value === "") return "未知";
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString("en-US") : String(value);
}

function formatQuota(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "未知";
  const amount = number / QUOTA_PER_UNIT;
  return amount.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

function formatCurrencyQuota(value) {
  const formatted = formatQuota(value);
  return formatted === "未知" ? "未知" : CURRENCY_SYMBOL + formatted;
}

function currentMonth() {
  const date = new Date();
  return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0");
}

function today() {
  const date = new Date();
  return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
}

function getFirstValue(objects, keys) {
  for (const object of objects) {
    if (!object || typeof object !== "object") continue;
    for (const key of keys) {
      if (object[key] !== undefined && object[key] !== null && object[key] !== "") return object[key];
    }
  }
  return undefined;
}

function accountSummary(user) {
  const name = getFirstValue([user], ["username", "display_name", "name"]) || "未命名账号";
  const quota = getFirstValue([user], ["quota"]);
  const used = getFirstValue([user], ["used_quota"]);
  return {
    name: String(name),
    text: "当前余额 " + formatCurrencyQuota(quota) + "，总用量 " + formatCurrencyQuota(used)
  };
}

function subscriptionSummary(payload) {
  const data = payload && payload.data;
  const subscriptions = Array.isArray(data && data.subscriptions) ? data.subscriptions : [];
  const now = Date.now() / 1000;
  const active = subscriptions.filter(item => {
    const subscription = item && (item.subscription || item);
    return subscription && subscription.status !== "cancelled" && (!subscription.end_time || subscription.end_time > now);
  });
  if (!active.length) return "";

  const item = active[0];
  const subscription = item.subscription || item;
  const plan = item.plan || {};
  const title = plan.title || item.plan_title || subscription.plan_title || "订阅";
  const days = subscription.end_time ? Math.max(0, Math.ceil((subscription.end_time - now) / 86400)) : 0;
  const total = Number(subscription.amount_total || 0);
  const used = Number(subscription.amount_used || 0);
  const remaining = total > 0 ? Math.max(0, total - used) : 0;
  let text = "订阅：" + title + "，有效";
  if (days) text += "，剩余 " + days + " 天";
  if (total > 0) text += "，剩余额度 " + formatCurrencyQuota(remaining);
  return text;
}

function isAlreadyCheckedIn(payload) {
  const text = JSON.stringify(payload || {});
  return /已签到|今日已签到|今天已签到|already\s*check(?:ed)?\s*in|already\s*signed|checked\s*in|重复签到|请勿重复/i.test(text);
}

function checkinReason(payload, response) {
  return apiMessage(payload, "HTTP " + ((response && response.status) || 0));
}

function captureCookie() {
  const cookie = headerValue($request.headers, "Cookie").trim();
  const userAgent = headerValue($request.headers, "User-Agent").trim() || DEFAULT_UA;
  const account = getArgument("account") || "账号";
  const notifyEnabled = getArgument("notify") !== "false";

  // Cookie 可能是仅用于 refresh 的 HttpOnly 会话，不能用 /self 预校验。
  if (!cookie) {
    notifyOnce("empty:" + account, "北执签到", account, "未获取到 Cookie，请确认已登录后重新打开个人中心。", notifyEnabled);
    $done({});
    return;
  }

  const stored = readJSON(COOKIE_KEY, []);
  const current = stored.find(item => item && item.name === account);
  const captured = readJSON(COOKIE_CAPTURED_KEY, {});
  const sameCookie = current && current.cookie === cookie && current.ua === userAgent;
  const next = stored.filter(item => item && item.name !== account);
  next.push({ name: account, identity: "name:" + account, cookie, ua: userAgent });

  if (!writeJSON(COOKIE_KEY, next)) {
    notify("北执签到", account, "Cookie 保存失败。", notifyEnabled);
  } else if (!sameCookie || captured[account] !== cookie) {
    captured[account] = cookie;
    writeJSON(COOKIE_CAPTURED_KEY, captured);
    notify("北执签到", account, "Cookie 获取成功，当前共保存 " + next.length + " 个账号", notifyEnabled);
  }
  $done({});
}

async function runAccount(account, policy) {
  const baseHeaders = accountHeaders(account.cookie, "", account.ua);
  const refresh = await request("POST", BASE_URL + "/api/user/auth/refresh", baseHeaders, policy);
  const refreshPayload = parseBody(refresh.data);
  const token = extractToken(refreshPayload);

  if (refresh.error) {
    return { name: account.name, ok: false, text: "刷新登录态失败：" + String(refresh.error) };
  }
  if (refresh.response.status === 401 || !token) {
    return { name: account.name, ok: false, text: "Cookie 已失效或账号未登录，刷新接口未返回有效登录令牌" };
  }
  if (refresh.response.status < 200 || refresh.response.status >= 300 || refreshPayload.success === false) {
    return { name: account.name, ok: false, text: "刷新登录态失败：" + apiMessage(refreshPayload, "HTTP " + refresh.response.status) };
  }

  const headers = accountHeaders(account.cookie, token, account.ua);
  const status = await request("GET", BASE_URL + "/api/user/checkin?month=" + encodeURIComponent(currentMonth()), headers, policy);
  const statusPayload = parseBody(status.data);
  if (status.error || status.response.status < 200 || status.response.status >= 300 || statusPayload.success === false) {
    return { name: account.name, ok: false, text: "签到状态查询失败：" + apiMessage(statusPayload, status.error || "HTTP " + status.response.status) };
  }
  const stats = statusPayload.data && statusPayload.data.stats;
  const checkedToday = !!(stats && (stats.checked_in_today === true || stats.checked_in_today === 1));

  let checkin = null;
  let checkinPayload = {};
  if (!checkedToday) {
    checkin = await request("POST", BASE_URL + "/api/user/checkin", headers, policy);
    checkinPayload = parseBody(checkin.data);
  }

  const profile = await request("GET", BASE_URL + "/api/user/self", headers, policy);
  const profilePayload = parseBody(profile.data);
  const subscription = await request("GET", BASE_URL + "/api/subscription/self", headers, policy);
  const subscriptionPayload = parseBody(subscription.data);

  if (profile.response.status === 401 || (!checkedToday && checkin.response.status === 401)) {
    return { name: account.name, ok: false, text: "登录令牌已失效，请重新捕获 Cookie" };
  }
  if (profile.error || (!checkedToday && checkin.error)) {
    return { name: account.name, ok: false, text: "网络请求失败：" + String(profile.error || checkin.error) };
  }

  const user = extractUser(profilePayload);
  const summary = accountSummary(user);
  const subscriptionText = subscriptionSummary(subscriptionPayload);
  const suffix = subscriptionText ? "；" + subscriptionText : "";
  if (checkedToday) {
    return { name: summary.name || account.name, ok: true, text: "已签到，" + summary.text + suffix };
  }

  const httpOk = checkin.response.status >= 200 && checkin.response.status < 300;
  const checkinOk = httpOk && checkinPayload.success !== false;
  const reward = getFirstValue([
    checkinPayload && checkinPayload.data,
    checkinPayload
  ], ["quota_awarded", "quota", "reward", "amount", "received"]);
  if (!checkinOk) {
    return { name: summary.name || account.name, ok: false, text: "签到失败：" + checkinReason(checkinPayload, checkin.response) + "；" + summary.text + suffix };
  }

  let text = "签到成功，" + summary.text;
  if (reward !== undefined) text += "，今日增加 " + formatCurrencyQuota(reward);
  return { name: summary.name || account.name, ok: true, text: text + suffix };
}

async function run() {
  const notifyEnabled = getArgument("notify") !== "false";
  const policy = getArgument("policy") || "DIRECT";
  const configured = parseAccounts(getArgument("cookies"));
  const stored = readJSON(COOKIE_KEY, []);
  const accounts = mergeAccounts(configured, Array.isArray(stored) ? stored : []);
  if (!accounts.length) {
    notify("北执签到", "未配置账号", "请先登录并打开个人中心捕获 Cookie。", notifyEnabled);
    $done();
    return;
  }

  const results = [];
  for (const account of accounts) {
    try { results.push(await runAccount(account, policy)); }
    catch (error) { results.push({ name: account.name, ok: false, text: error.message || "脚本异常" }); }
  }
  const failed = results.filter(item => !item.ok).length;
  const body = results.map((item, index) => (index + 1) + ". " + item.name + "：" + item.text).join("\n");
  notify("北执每日签到", failed ? (failed + " 个账号失败") : (results.length + " 个账号完成"), body, notifyEnabled || failed > 0);
  $done();
}

if (typeof $request !== "undefined" && $request && typeof $script !== "undefined" && $script.type === "http-request") captureCookie();
else run().catch(error => {
  notify("北执每日签到", "脚本异常", String(error && error.message || error), true);
  $done();
});
