// Progressive enhancement: mobile nav, active-section highlight, code copy-buttons, and the
// interactive hero look-up demo (real TTS + kana toggle + queue/mine feedback).
(function () {
  "use strict";

  /* ---------- mobile nav ---------- */
  const toggle = document.getElementById("navToggle");
  const links = document.getElementById("navLinks");
  if (toggle && links) {
    toggle.addEventListener("click", () => links.classList.toggle("open"));
    links.addEventListener("click", (e) => {
      if (e.target.tagName === "A") links.classList.remove("open");
    });
  }

  /* ---------- active-section highlight ---------- */
  const navLinks = [...document.querySelectorAll('.nav__links a[href^="#"]')];
  if (navLinks.length) {
    const byId = new Map(navLinks.map((a) => [a.getAttribute("href").slice(1), a]));
    const sections = [...byId.keys()].map((id) => document.getElementById(id)).filter(Boolean);
    const spy = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          navLinks.forEach((a) => a.classList.remove("nav__active"));
          byId.get(e.target.id)?.classList.add("nav__active");
        }
      },
      { rootMargin: "-45% 0px -50% 0px", threshold: 0 },
    );
    sections.forEach((s) => spy.observe(s));
  }

  /* ---------- tutorial TOC scroll-spy ---------- */
  const tocLinks = [...document.querySelectorAll('.toc a[href^="#"]')];
  if (tocLinks.length) {
    const tById = new Map(tocLinks.map((a) => [a.getAttribute("href").slice(1), a]));
    const tSections = [...tById.keys()].map((id) => document.getElementById(id)).filter(Boolean);
    const tSpy = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          tocLinks.forEach((a) => a.classList.remove("toc--active"));
          tById.get(e.target.id)?.classList.add("toc--active");
        }
      },
      { rootMargin: "-20% 0px -70% 0px", threshold: 0 },
    );
    tSections.forEach((s) => tSpy.observe(s));
  }

  /* ---------- copy buttons on code blocks (tutorial) ---------- */
  document.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const text = btn.getAttribute("data-copy");
      try {
        await navigator.clipboard.writeText(text);
        const old = btn.textContent;
        btn.textContent = "✓ Copied";
        btn.classList.add("copied");
        setTimeout(() => { btn.textContent = old; btn.classList.remove("copied"); }, 1400);
      } catch { /* clipboard blocked */ }
    });
  });

  /* ---------- interactive hero look-up demo ---------- */
  const demo = document.getElementById("heroDemo");
  if (!demo) return;

  const toastEl = document.getElementById("demoToast");
  let toastTimer = 0;
  const toast = (msg) => {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1800);
  };

  // hiragana <-> katakana for the あ toggle. Store each reading's original hiragana once.
  const toKata = (s) => s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
  const rts = [...demo.querySelectorAll("rt")];
  rts.forEach((rt) => (rt.dataset.hira = rt.textContent));
  let kata = false;
  const kanaBtn = document.getElementById("demoKana");
  kanaBtn?.addEventListener("click", () => {
    kata = !kata;
    rts.forEach((rt) => (rt.textContent = kata ? toKata(rt.dataset.hira) : rt.dataset.hira));
    kanaBtn.classList.toggle("lk-btn--on", kata);
    toast(kata ? "Readings → katakana" : "Readings → hiragana");
  });

  // 🔊 speak the reading with the browser's Japanese voice.
  document.getElementById("demoSpeak")?.addEventListener("click", (e) => {
    const btn = e.currentTarget;
    btn.classList.add("speaking");
    setTimeout(() => btn.classList.remove("speaking"), 900);
    try {
      const u = new SpeechSynthesisUtterance("べんきょう");
      u.lang = "ja-JP";
      u.rate = 0.95;
      const ja = speechSynthesis.getVoices().find((v) => /ja|japanese/i.test(v.lang + v.name));
      if (ja) u.voice = ja;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
      toast("🔊 べんきょう");
    } catch {
      toast("Speech not available in this browser");
    }
  });

  // ⧉ queue: toggle a queued state + bump the toolbar badge.
  const badge = document.getElementById("demoBadge");
  const queueBtn = document.getElementById("demoQueue");
  let queued = false;
  let count = badge ? parseInt(badge.textContent, 10) || 0 : 0;
  queueBtn?.addEventListener("click", () => {
    queued = !queued;
    count += queued ? 1 : -1;
    if (badge) badge.textContent = String(count);
    queueBtn.classList.toggle("lk-btn--filled", queued);
    toast(queued ? `Queued — ${count} words waiting to mine` : "Removed from queue");
  });

  // ＋ mine: flip to ✓ briefly with a confirmation.
  const mineBtn = document.getElementById("demoMine");
  mineBtn?.addEventListener("click", () => {
    if (mineBtn.classList.contains("lk-btn--done")) return;
    mineBtn.textContent = "✓";
    mineBtn.classList.add("lk-btn--done");
    toast("✓ Added to Anki");
    setTimeout(() => { mineBtn.textContent = "＋"; mineBtn.classList.remove("lk-btn--done"); }, 1600);
  });
})();
