// The team dashboard page, as one self-contained string served by the viewer Lambda.
//
// No build step, no framework, no CDN — deliberately. It is served from the studio's own
// Lambda, so every byte a viewer's browser runs is a byte in this repository, auditable by
// the same rule as the rest of the poppy. It authenticates against Cognito directly with
// fetch (USER_PASSWORD_AUTH on a public client), keeps the ID token in memory only — never
// localStorage, so closing the tab ends the session — and asks our own /api/stats for
// numbers.

export const VIEWER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>Game dashboard</title>
<!-- Favicon inline as a data URI (64px, ~1.9 KB), the way TrafficPoppy's dashboard does
     it: this page is served by ONE Lambda route, so a /favicon.ico link would 404 on
     every visit and leave the tab showing a browser default. Inline costs one round
     trip less and no extra route. -->
<link rel="icon" href="data:image/png;base64,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">
<style>
  :root { --bg:#0e0d0c; --card:#171614; --line:#2e2b27; --text:#ece9e2; --muted:#8f8a80;
          --accent:#e6c68a; --ok:#7fce9a; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); min-height:100vh;
         font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  .wrap { max-width:1000px; margin:0 auto; padding:28px 20px 64px; }
  h1 { font-size:20px; margin:0 0 2px; } .sub { color:var(--muted); font-size:13px; margin:0 0 22px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; margin-bottom:14px; }
  label { display:block; font-size:12px; color:var(--muted); margin:10px 0 4px; }
  input, select { width:100%; padding:10px 11px; border-radius:8px; border:1px solid var(--line);
                  background:#0c0b0a; color:var(--text); font-size:14px; }
  button { border:0; border-radius:9px; padding:11px 16px; font-size:14px; font-weight:600;
           background:var(--accent); color:#221a0d; cursor:pointer; }
  button:disabled { opacity:.6; cursor:default; }
  .row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
  .tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; }
  .tile { background:#0c0b0a; border:1px solid var(--line); border-radius:10px; padding:13px; }
  .tile b { display:block; font-size:24px; font-weight:650; }
  .tile span { color:var(--muted); font-size:12px; }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  td { padding:6px 0; border-bottom:1px solid var(--line); }
  td:last-child { text-align:right; color:var(--muted); font-variant-numeric:tabular-nums; }
  .err { color:#e0685a; font-size:13px; min-height:18px; margin-top:8px; }
  .muted { color:var(--muted); font-size:12px; }
  .bars { display:flex; align-items:flex-end; gap:3px; height:70px; margin-top:12px; }
  .bars i { flex:1; background:#7a6a58; border-radius:2px 2px 0 0; min-height:2px; }
  .bars i:last-child { background:var(--accent); }
  #app { display:none; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Game dashboard</h1>
  <p class="sub">Read-only. Runs in your studio's own AWS account.</p>

  <section id="login" class="card">
    <strong>Sign in</strong>
    <p class="muted" style="margin:6px 0 0">Use the email your studio invited.</p>
    <label for="email">Email</label>
    <input id="email" type="email" autocomplete="username" />
    <label for="pw">Password</label>
    <input id="pw" type="password" autocomplete="current-password" />
    <div id="newpw-wrap" style="display:none">
      <label for="newpw">Choose a new password (first sign-in)</label>
      <input id="newpw" type="password" autocomplete="new-password" />
    </div>
    <p class="err" id="err"></p>
    <button id="go">Sign in</button>
  </section>

  <div id="app">
    <div class="card">
      <div class="row">
        <select id="title" style="flex:1;min-width:160px"></select>
        <select id="days" style="width:110px">
          <option value="7">7 days</option>
          <option value="30" selected>30 days</option>
          <option value="90">90 days</option>
        </select>
        <button id="out" style="background:transparent;color:var(--muted);border:1px solid var(--line)">Sign out</button>
      </div>
    </div>

    <div class="card">
      <div class="tiles">
        <div class="tile"><b id="t-dau">—</b><span>Players today</span></div>
        <div class="tile"><b id="t-sessions">—</b><span>Sessions</span></div>
        <div class="tile"><b id="t-len">—</b><span>Avg session</span></div>
        <div class="tile"><b id="t-events">—</b><span>Events</span></div>
      </div>
      <div class="bars" id="bars"></div>
      <p class="muted" id="range"></p>
    </div>

    <div class="card">
      <strong>Retention</strong>
      <div class="tiles" style="margin-top:10px">
        <div class="tile"><b id="r-d1">—</b><span>Day 1</span></div>
        <div class="tile"><b id="r-d7">—</b><span>Day 7</span></div>
        <div class="tile"><b id="r-d30">—</b><span>Day 30</span></div>
      </div>
      <p class="muted" style="margin-bottom:0">Cohorts too young to have reached a milestone are left out, not counted as zero.</p>
    </div>

    <div class="card"><strong>Events</strong><table id="events"></table></div>
    <div class="card"><strong>Platforms</strong><table id="platforms"></table></div>
  </div>
</div>

<script>
"use strict";
var $ = function (id) { return document.getElementById(id); };
var idToken = null;      // memory only — closing the tab ends the session
var cognito = null;      // { issuer, clientId }
var session = null;      // NEW_PASSWORD_REQUIRED continuation

function cognitoEndpoint() {
  // issuer is https://cognito-idp.<region>.amazonaws.com/<poolId>
  return cognito.issuer.replace(/\\/[^/]+$/, "");
}

function idp(target, body) {
  return fetch(cognitoEndpoint(), {
    method: "POST",
    headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "AWSCognitoIdentityProviderService." + target },
    body: JSON.stringify(body),
  }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); });
}

function signIn() {
  var email = $("email").value.trim(), pw = $("pw").value, newpw = $("newpw").value;
  $("err").textContent = "";
  $("go").disabled = true;

  var step = session
    ? idp("RespondToAuthChallenge", {
        ClientId: cognito.clientId, ChallengeName: "NEW_PASSWORD_REQUIRED", Session: session,
        ChallengeResponses: { USERNAME: email, NEW_PASSWORD: newpw },
      })
    : idp("InitiateAuth", {
        ClientId: cognito.clientId, AuthFlow: "USER_PASSWORD_AUTH",
        AuthParameters: { USERNAME: email, PASSWORD: pw },
      });

  step.then(function (res) {
    $("go").disabled = false;
    if (!res.ok) {
      $("err").textContent = "That email and password didn't match.";
      return;
    }
    if (res.body.ChallengeName === "NEW_PASSWORD_REQUIRED") {
      session = res.body.Session;
      $("newpw-wrap").style.display = "block";
      $("err").textContent = "Please choose a new password to finish setting up your account.";
      return;
    }
    idToken = res.body.AuthenticationResult && res.body.AuthenticationResult.IdToken;
    if (!idToken) { $("err").textContent = "Sign-in failed. Please try again."; return; }
    $("login").style.display = "none";
    $("app").style.display = "block";
    load();
  }).catch(function () {
    $("go").disabled = false;
    $("err").textContent = "Couldn't reach the sign-in service.";
  });
}

function fmt(n) { return (n || 0).toLocaleString(); }
function fmtLen(sec) {
  if (!sec) return "—";
  var m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return m ? m + "m " + s + "s" : s + "s";
}
function rows(table, list) {
  table.innerHTML = list.length
    ? list.map(function (x) { return "<tr><td>" + x.name + "</td><td>" + fmt(x.count) + "</td></tr>"; }).join("")
    : "<tr><td class='muted'>Nothing yet.</td><td></td></tr>";
}

function load() {
  var q = "?days=" + $("days").value + (($("title").value) ? "&title=" + encodeURIComponent($("title").value) : "");
  fetch("api/stats" + q, { headers: { authorization: "Bearer " + idToken } })
    .then(function (r) {
      if (r.status === 401) { signOut("Your session expired — please sign in again."); return null; }
      return r.json();
    })
    .then(function (d) {
      if (!d) return;
      if ($("title").options.length !== (d.titles || []).length) {
        $("title").innerHTML = (d.titles || []).map(function (t) {
          return "<option value='" + t.titleId + "'>" + t.name + "</option>";
        }).join("");
        if (d.titleId) $("title").value = d.titleId;
      }
      var days = d.days || [];
      var last = days[days.length - 1] || {};
      var totalSessions = days.reduce(function (a, x) { return a + x.sessions; }, 0);
      var totalSeconds = days.reduce(function (a, x) { return a + x.sessionSeconds; }, 0);
      $("t-dau").textContent = fmt(last.dau);
      $("t-sessions").textContent = fmt(totalSessions);
      $("t-len").textContent = fmtLen(totalSessions ? totalSeconds / totalSessions : 0);
      $("t-events").textContent = fmt(days.reduce(function (a, x) { return a + x.events; }, 0));
      var max = Math.max.apply(null, days.map(function (x) { return x.dau; }).concat([1]));
      $("bars").innerHTML = days.map(function (x) {
        return "<i style='height:" + Math.max(2, Math.round((x.dau / max) * 100)) + "%' title='" + x.day + ": " + fmt(x.dau) + "'></i>";
      }).join("");
      $("range").textContent = days.length ? days[0].day + " → " + days[days.length - 1].day : "";
      var r = d.retention || {};
      $("r-d1").textContent = r.d1 == null ? "—" : r.d1 + "%";
      $("r-d7").textContent = r.d7 == null ? "—" : r.d7 + "%";
      $("r-d30").textContent = r.d30 == null ? "—" : r.d30 + "%";
      rows($("events"), d.events || []);
      rows($("platforms"), d.platforms || []);
    })
    .catch(function () { /* transient — the next poll or interaction retries */ });
}

function signOut(msg) {
  idToken = null; session = null;
  $("app").style.display = "none";
  $("login").style.display = "block";
  $("pw").value = "";
  $("err").textContent = msg || "";
}

$("go").addEventListener("click", signIn);
$("pw").addEventListener("keydown", function (e) { if (e.key === "Enter") signIn(); });
$("title").addEventListener("change", load);
$("days").addEventListener("change", load);
$("out").addEventListener("click", function () { signOut(""); });

fetch("api/config").then(function (r) { return r.json(); }).then(function (c) { cognito = c; })
  .catch(function () { $("err").textContent = "Couldn't load the dashboard configuration."; });
</script>
</body>
</html>`;
