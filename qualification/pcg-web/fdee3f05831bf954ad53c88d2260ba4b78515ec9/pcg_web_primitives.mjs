import { TELEGRAM_SELECTORS } from "./pcg_web_selectors.mjs";

function fail(code) {
  const err = new Error(code);
  err.code = code;
  throw err;
}

async function visibleSearchInput(page) {
  const inputs = page.locator(TELEGRAM_SELECTORS.search);
  const count = await inputs.count();
  for (let i = 0; i < count; i++) {
    const input = inputs.nth(i);
    if (await input.isVisible().catch(() => false)) return input;
  }
  fail("SEARCH_INPUT_NOT_FOUND");
}

export async function protectedConversationTitle(row) {
  return await row.evaluate((el, selectors) => {
    for (const selector of selectors) {
      const node = el.querySelector(selector);
      const value = (node?.textContent || "").trim();
      if (value) return value.slice(0, 256);
    }
    const aria = (el.getAttribute("aria-label") || "").trim();
    if (aria) return aria.slice(0, 256);
    const first = (el.innerText || "").split("\n").map((v) => v.trim()).find(Boolean) || "";
    return first.slice(0, 256);
  }, TELEGRAM_SELECTORS.conversationTitles);
}

export async function visibleConversationEntries(page, identity, limit) {
  const rows = page.locator(TELEGRAM_SELECTORS.chatRow);
  const count = await rows.count();
  const entries = [];
  for (let i = 0; i < count && entries.length < limit; i++) {
    const row = rows.nth(i);
    if (!(await row.isVisible().catch(() => false))) continue;
    const providerRef = await row.getAttribute("data-peer-id");
    if (!providerRef) continue;
    const name = await protectedConversationTitle(row);
    if (!name) continue;
    entries.push({
      handle: identity.opaqueConversationHandle(providerRef),
      name,
      type: identity.protectedConversationType(providerRef),
    });
  }
  return entries;
}

export async function unreadConversationRefs(page) {
  const rows = page.locator(TELEGRAM_SELECTORS.chatRow);
  const count = await rows.count();
  const refs = [];
  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    if (!(await row.isVisible().catch(() => false))) continue;
    const badge = row.locator(TELEGRAM_SELECTORS.unreadBadge).first();
    if (!(await badge.isVisible().catch(() => false))) continue;
    const providerRef = await row.getAttribute("data-peer-id");
    if (providerRef) refs.push(providerRef);
  }
  return refs;
}

export async function locateVisibleConversationRowByHandle(page, identity, handle) {
  const providerRef = identity.providerRefForHandle(handle);
  const rows = page.locator(TELEGRAM_SELECTORS.chatRow);
  const count = await rows.count();
  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    if (!(await row.isVisible().catch(() => false))) continue;
    if ((await row.getAttribute("data-peer-id")) === providerRef) {
      return { row, providerRef };
    }
  }
  return null;
}

export async function withConversationSearch(page, query, fn) {
  const input = await visibleSearchInput(page);
  const beforeUrl = page.url();
  let result;
  try {
    await input.fill(query);
    await page.waitForTimeout(900);
    result = await fn();
  } finally {
    try {
      await input.fill("");
      await input.press("Escape");
      await page.waitForTimeout(1200);
    } catch {
      fail("SEARCH_RESET_FAILED");
    }
  }
  return { result, navigationUnchanged: page.url() === beforeUrl };
}
