/*
 * Beizhi / New API daily check-in for Surge.
 * Cookie format: account name:::cookie|||another name:::cookie
 */
const BASE_URL = "https://beizhi.sylu.cc";
const COOKIE_KEY = "beizhi_sylu_checkin_cookies";
const COOKIE_CAPTURED_KEY = "beizhi_sylu_checkin_captured";
const COOKIE_UA_KEY = "beizhi_sylu_checkin_ua";
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
  if (enabled !== false) $notification.post(title, subtitle || "", body || "");
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

function accountSummary(user) {
  const name = user.username || user.display_name || user.name || "未命名账号";
  const quota = user.quota !== undefined ? user.quota : user.remaining_quota;
  const used = user.used_quota !== undefined ? user.used_quota : user.usedQuota;
  const parts = ["额度 " + formatNumber(quota)];
  if (used !== undefined) parts.push("已用 " + formatNumber(used));
  return { name: String(name), text: parts.join("，") };
}

function captureCookie() {
  const cookie = headerValue($request.headers, "Cookie").trim();
  const userAgent = headerValue($request.headers, "User-Agent").trim();
  const account = getArgument("account") || "账号";
  const notifyEnabled = getArgument("notify") !== "false";

  // /profile 是唯一捕获入口；无 Cookie 的未登录请求直接忽略。
  if (!cookie) {
    $done({});
    return;
  }

  const stored = readJSON(COOKIE_KEY, []);
  const current = stored.find(item => item && item.name === account);
  const captured = readJSON(COOKIE_CAPTURED_KEY, {});
  const normalizedUA = userAgent || (current && current.ua) || DEFAULT_UA;
  const sameCookie = current && current.cookie === cookie && current.ua === normalizedUA;
  const next = stored.filter(item => item && item.name !== account && item.cookie !== cookie);
  next.unshift({ name: account, cookie, ua: normalizedUA });

  if (!writeJSON(COOKIE_KEY, next)) {
    notify("北执签到", account, "Cookie 保存失败。", notifyEnabled);
  } else if (!sameCookie || captured[account] !== cookie) {
    captured[account] = cookie;
    writeJSON(COOKIE_CAPTURED_KEY, captured);
    notify("北执签到", account, "Cookie 已保存，可用于定时签到。", notifyEnabled);
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
  const checkin = await request("POST", BASE_URL + "/api/user/checkin", headers, policy, {});
  const checkinPayload = parseBody(checkin.data);
  const profile = await request("GET", BASE_URL + "/api/user/self", headers, policy);
  const profilePayload = parseBody(profile.data);

  if (checkin.response.status === 401 || profile.response.status === 401) {
    return { name: account.name, ok: false, text: "登录令牌已失效，请重新捕获 Cookie" };
  }
  if (checkin.error || profile.error) {
    return { name: account.name, ok: false, text: "网络请求失败：" + String(checkin.error || profile.error) };
  }

  const user = extractUser(profilePayload);
  const summary = accountSummary(user);
  const checkinOk = checkin.response.status >= 200 && checkin.response.status < 300 && checkinPayload.success !== false;
  const reward = checkinPayload.data && (checkinPayload.data.quota || checkinPayload.data.reward || checkinPayload.data.amount);
  let action = checkinOk ? "签到请求成功" : apiMessage(checkinPayload, "签到未成功");
  if (reward !== undefined) action += "，奖励 " + formatNumber(reward);
  return { name: summary.name || account.name, ok: checkinOk, text: action + "；" + summary.text };
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
else run();
