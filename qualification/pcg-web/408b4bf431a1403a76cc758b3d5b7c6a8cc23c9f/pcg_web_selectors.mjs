export const TELEGRAM_SELECTORS = Object.freeze({
  ready: "#page-chats",
  phone: 'input[name="phone"], .input-field-phone .input-field-input[contenteditable="true"]',
  code: 'input[autocomplete="one-time-code"]',
  password: 'input[name="notsearch_password"]',
  authRoot: "#auth-flow-root",
  chatRow: "a.chatlist-chat",
  unreadBadge: ".dialog-subtitle-badge-unread.is-visible",
  conversationTitles: Object.freeze([".peer-title", ".chatlist-chat-title", ".dialog-title"]),
  search: 'input[placeholder*="Search" i], .input-search input, [contenteditable="true"][data-placeholder*="Search" i]',
});
