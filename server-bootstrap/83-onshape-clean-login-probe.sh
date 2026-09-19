#!/usr/bin/env bash
set -euo pipefail

[[ "$(id -u)" -eq 0 ]] || { echo "must run as uid 0" >&2; exit 1; }

account=/etc/capability-fabric/secrets/onshape/account
password=/etc/capability-fabric/secrets/onshape/password
for f in "$account" "$password"; do
  [[ -s "$f" ]] || { echo "Onshape credentials are not provisioned" >&2; exit 20; }
  [[ "$(stat -c '%a %U:%G' "$f")" == "600 root:root" ]] || { echo "Onshape credential permissions are unsafe" >&2; exit 21; }
done

cid="$(docker inspect -f '{{.Id}}' capability-fabric-onshape-server 2>/dev/null || true)"
[[ -n "$cid" ]] || { echo "Onshape server container missing" >&2; exit 22; }
[[ "$(docker inspect -f '{{.State.Running}}' "$cid")" == "true" ]] || { echo "Onshape server container not running" >&2; exit 22; }

cleanup() {
  docker exec "$cid" sh -lc 'rm -rf /tmp/clean-login-probe-profile' >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker exec -i "$cid" sh -lc 'cd /tmp/app && node --input-type=module -' <<'JS'
import fs from "node:fs";
import { chromium } from "playwright";

const CAD_ORIGIN = "https://cad.onshape.com";
const SIGNIN_URL = CAD_ORIGIN + "/signin";
const account = fs.readFileSync("/run/onshape-secrets/account", "utf8");
const password = fs.readFileSync("/run/onshape-secrets/password", "utf8");
const profile = "/tmp/clean-login-probe-profile";

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    const loc = page.locator(selector).first();
    try { if (await loc.isVisible({ timeout: 250 })) return loc; } catch {}
  }
  return null;
}

async function authenticated(page) {
  try {
    const result = await page.evaluate(async () => {
      const r = await fetch("/api/users/sessioninfo", {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      return r.ok;
    });
    return !!result;
  } catch {
    return false;
  }
}

async function classification() {
  fs.rmSync(profile, { recursive: true, force: true });
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    chromiumSandbox: false,
    viewport: { width: 1440, height: 1000 },
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(10000);
  page.setDefaultNavigationTimeout(45000);

  let emailSubmitted = false;
  let passwordSubmitted = false;

  try {
    await page.goto(SIGNIN_URL, { waitUntil: "domcontentloaded" });

    for (let step = 0; step < 50; step++) {
      if (await authenticated(page)) return "AUTHENTICATED";

      const verification = await firstVisible(page, [
        'input[autocomplete="one-time-code"]',
        'input[name*="code" i]',
        'input[id*="code" i]',
        'input[type="tel"]',
      ]);
      if (verification) return "EMAIL_VERIFICATION_CODE";

      const body = await page.locator("body").innerText().catch(() => "");
      if (/captcha|recaptcha|robot/i.test(body)) return "INTERACTIVE_CHALLENGE";
      if (/approve.*device|device.*approval|verify.*identity|confirm.*identity/i.test(body)) return "DEVICE_OR_IDENTITY_CHALLENGE";
      if (passwordSubmitted && /incorrect password|wrong password|invalid credentials|unable to sign in/i.test(body)) return "CREDENTIAL_REJECTED";

      const email = await firstVisible(page, [
        'input[type="email"]',
        'input[autocomplete="username"]',
        'input[name*="email" i]',
        'input[id*="email" i]',
      ]);
      const pass = await firstVisible(page, [
        'input[type="password"]',
        'input[autocomplete="current-password"]',
        'input[name*="password" i]',
      ]);

      if (email && !emailSubmitted) {
        await email.fill(account);
        emailSubmitted = true;
        if (pass) {
          await pass.fill(password);
          passwordSubmitted = true;
        }
        const submit = await firstVisible(page, [
          'button[type="submit"]',
          'input[type="submit"]',
          'button:has-text("Sign in")',
          'button:has-text("Log in")',
          'button:has-text("Continue")',
          'button:has-text("Next")',
        ]);
        if (submit) await submit.click();
        else await email.press("Enter");
        await sleep(1500);
        continue;
      }

      if (pass && !passwordSubmitted) {
        await pass.fill(password);
        passwordSubmitted = true;
        const submit = await firstVisible(page, [
          'button[type="submit"]',
          'input[type="submit"]',
          'button:has-text("Sign in")',
          'button:has-text("Log in")',
          'button:has-text("Continue")',
        ]);
        if (submit) await submit.click();
        else await pass.press("Enter");
        await sleep(1800);
        continue;
      }

      await sleep(1000);
    }

    return "UNRESOLVED";
  } finally {
    await context.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

const result = await classification();
console.log("CF_ONSHAPE_CLEAN_LOGIN=" + result);
JS
