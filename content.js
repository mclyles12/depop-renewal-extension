// content.js — Runs on depop.com/products/*/edit/ pages
// Currently passive — used by the background worker via scripting.executeScript
// This file exists so the extension has proper content script context on edit pages.

(function () {
  // Signal to background that this edit page is ready
  window.__depopRenewerReady = true;
})();
