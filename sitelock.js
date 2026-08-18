(function () {
  var HASH = "742e08d300002a3fe98d2fd818c3a579e351c74567e05111d438b21254850aa4";
  var KEY = "thp_unlocked";

  function sha256Hex(str) {
    var enc = new TextEncoder().encode(str);
    return crypto.subtle.digest("SHA-256", enc).then(function (buf) {
      return Array.prototype.map
        .call(new Uint8Array(buf), function (b) {
          return b.toString(16).padStart(2, "0");
        })
        .join("");
    });
  }

  function reveal() {
    document.documentElement.style.visibility = "visible";
    var overlay = document.getElementById("thp-lock-overlay");
    if (overlay) overlay.remove();
  }

  function showOverlay() {
    var overlay = document.createElement("div");
    overlay.id = "thp-lock-overlay";
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;background:#060E1A;" +
      "display:flex;align-items:center;justify-content:center;" +
      "font-family:'DM Sans',Arial,sans-serif;";
    overlay.innerHTML =
      '<form id="thp-lock-form" style="background:#0d1f3c;padding:40px 36px;border-radius:16px;max-width:320px;width:90%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.45);border:1px solid rgba(255,255,255,0.08)">' +
      '<div style="color:#fff;font-weight:700;font-size:18px;margin-bottom:18px">Protected Preview</div>' +
      '<input type="password" id="thp-lock-input" placeholder="Enter password" autocomplete="off" autofocus ' +
      'style="width:100%;padding:12px 14px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.05);color:#fff;margin-bottom:12px;box-sizing:border-box;font-size:14px"/>' +
      '<div id="thp-lock-error" style="color:#e74c3c;font-size:13px;min-height:18px;margin-bottom:6px"></div>' +
      '<button type="submit" style="width:100%;padding:12px;border-radius:8px;border:none;background:#00D4BC;color:#001b16;font-weight:700;font-size:14px;cursor:pointer">Enter</button>' +
      "</form>";

    document.documentElement.style.visibility = "visible";
    document.body.appendChild(overlay);

    document
      .getElementById("thp-lock-form")
      .addEventListener("submit", function (e) {
        e.preventDefault();
        var input = document.getElementById("thp-lock-input");
        var val = input.value;
        sha256Hex(val).then(function (hash) {
          if (hash === HASH) {
            try {
              sessionStorage.setItem(KEY, "1");
            } catch (err) {}
            reveal();
          } else {
            document.getElementById("thp-lock-error").textContent =
              "Incorrect password.";
            input.value = "";
            input.focus();
          }
        });
      });
  }

  var unlocked = false;
  try {
    unlocked = sessionStorage.getItem(KEY) === "1";
  } catch (err) {}

  if (unlocked) {
    document.documentElement.style.visibility = "visible";
  } else {
    showOverlay();
  }
})();
