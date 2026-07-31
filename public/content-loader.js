// Tiny manifest content-script. MV3 content scripts can't be ES modules directly,
// so we dynamic-import the real ESM bundle, which is a web-accessible resource.
// This keeps the overlay code as normal modules.
(function () {
  "use strict";
  if (window.__tnmLoaded) return;
  window.__tnmLoaded = true;
  import(chrome.runtime.getURL("assets/content.js")).catch(function (e) {
    console.error("[tnm] failed to load content script:", e);
  });
})();
