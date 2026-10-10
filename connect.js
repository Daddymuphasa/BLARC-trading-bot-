(function () {
  "use strict";

  var WALLETS = [
    ["🦊 MetaMask", "https://metamask.app.link/wc"],
    ["🛡️ Trust Wallet", "https://link.trustwallet.com/wc"],
    ["🌈 Rainbow", "https://rnbwapp.com/wc"],
    ["🅱️ Bitget Wallet", "https://bkapp.vip/wc"],
    ["⚡ Zerion", "https://wallet.zerion.io/wc"],
    ["🦄 Uniswap", "https://uniswap.org/app/wc"],
  ];

  function readUri() {
    var hash = window.location.hash.replace(/^#/, "");
    var params = new URLSearchParams(hash);
    var uri = params.get("uri") || "";
    return /^wc:[0-9a-f]{64}@2\?/i.test(uri) ? uri : "";
  }

  var uri = readUri();
  if (!uri) {
    document.getElementById("missing").hidden = false;
    return;
  }

  // Keep the pairing code out of browser history once it is read.
  try {
    window.history.replaceState(null, "", window.location.pathname);
  } catch (e) {}

  var encoded = encodeURIComponent(uri);
  document.getElementById("open-any").href = uri;

  var grid = document.getElementById("wallets");
  WALLETS.forEach(function (wallet) {
    var a = document.createElement("a");
    a.className = "wallet";
    a.textContent = wallet[0];
    a.href = wallet[1] + "?uri=" + encoded;
    a.rel = "noopener noreferrer";
    grid.appendChild(a);
  });

  document.getElementById("copy").addEventListener("click", function () {
    var done = function () {
      document.getElementById("copied").hidden = false;
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(uri).then(done, function () {
        window.prompt("Copy this pairing link:", uri);
      });
    } else {
      window.prompt("Copy this pairing link:", uri);
    }
  });

  document.getElementById("ready").hidden = false;
})();
