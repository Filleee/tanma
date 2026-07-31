// Runs in YouTube's MAIN world (see manifest). Extracts caption-track metadata
// and posts it to the isolated content script via window.postMessage.
//
// IMPORTANT: this file must stay free of ES imports/exports — MV3 injects
// MAIN-world content scripts as classic scripts.

(function () {
  "use strict";

  const POST_SOURCE = "tnm-yt";
  let lastVideoId = "";
  // The last original (non-translated) timedtext request we saw — its POT token +
  // signature cover `tlang`, so we can re-issue it to fetch the auto-translation
  // even after the original was already captured (e.g. user toggles it on later).
  // Declared here (not lower) so extractFromPlayerResponse can reset them at load.
  let lastTargetUrl = "";
  let lastTargetLang = "";

  function trackName(t: any): string {
    return t?.name?.simpleText ?? t?.name?.runs?.map((r: any) => r.text).join("") ?? t?.languageCode ?? "";
  }

  function postTracks(videoId: string, captionTracks: any[]) {
    if (!videoId || !Array.isArray(captionTracks) || captionTracks.length === 0) return;
    const tracks = captionTracks.map((t) => ({
      baseUrl: t.baseUrl,
      lang: t.languageCode ?? "",
      name: trackName(t),
      kind: t.kind ?? "",
    }));
    window.postMessage({ source: POST_SOURCE, kind: "tracks", videoId, tracks }, "*");
  }

  function extractFromPlayerResponse(pr: any) {
    try {
      const videoId = pr?.videoDetails?.videoId ?? "";
      const captionTracks =
        pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
      if (videoId && videoId !== lastVideoId) {
        lastVideoId = videoId;
        lastTargetUrl = "";
        lastTargetLang = "";
        window.postMessage({ source: POST_SOURCE, kind: "videoChanged", videoId }, "*");
      }
      postTracks(videoId, captionTracks);
    } catch {
      /* ignore */
    }
  }

  // 1) Initial page load: the first video's data is on window.
  function tryInitial() {
    const pr = (window as any).ytInitialPlayerResponse;
    if (pr) extractFromPlayerResponse(pr);
  }
  tryInitial();
  document.addEventListener("DOMContentLoaded", tryInitial);
  window.addEventListener("load", tryInitial);

  // Capture YouTube's OWN timedtext responses. YouTube fetches these with a valid
  // proof-of-origin token (which we can't forge), so piggy-backing on its request
  // is the reliable way to get caption data. Requires the user to have captions on.
  const seenCaptions = new Set<string>();
  const requestedTlang = new Set<string>();
  // Language to machine-translate the target track INTO (YouTube's own tlang), set
  // by the content script when "Show translation" is on. "" disables it.
  let translateTo = "";

  function normLang(s: string): string {
    return (s || "").toLowerCase().split("-")[0];
  }

  // Re-request the captured target track with tlang set; the fetch hook re-enters
  // onTimedtext, sees tlang, and posts it as the secondary (translation) track.
  function maybeFetchTranslation() {
    if (!translateTo || !lastTargetUrl || normLang(translateTo) === normLang(lastTargetLang)) return;
    const rk = `${lastVideoId}:${lastTargetLang}:${translateTo}`;
    if (requestedTlang.has(rk)) return;
    requestedTlang.add(rk);
    try {
      const tu = new URL(lastTargetUrl, location.href);
      tu.searchParams.set("tlang", translateTo);
      window.fetch(tu.toString()).catch(() => {});
    } catch {
      /* ignore */
    }
  }

  function onTimedtext(url: string, body: string) {
    if (!body || body.length < 2) return;
    let lang = "";
    let kind = "";
    let tlang = "";
    try {
      const u = new URL(url, location.href);
      lang = u.searchParams.get("lang") ?? "";
      kind = u.searchParams.get("kind") ?? "";
      tlang = u.searchParams.get("tlang") ?? "";
    } catch {
      /* ignore */
    }
    // When tlang is present this IS a translation: its effective language is tlang
    // (the lang param still names the source track).
    const effectiveLang = tlang || lang;
    const key = `${lastVideoId}:${effectiveLang}:${body.length}`;
    if (seenCaptions.has(key)) return;
    seenCaptions.add(key);
    window.postMessage(
      {
        source: POST_SOURCE,
        kind: "captionData",
        videoId: lastVideoId,
        lang: effectiveLang,
        asr: kind === "asr",
        translated: !!tlang,
        body,
      },
      "*",
    );

    // Remember the original track so we can fetch its auto-translation on demand,
    // and kick it off now if a translation is already wanted.
    if (!tlang) {
      lastTargetUrl = url;
      lastTargetLang = lang;
      maybeFetchTranslation();
    }
  }

  // 2) SPA navigation + subsequent videos: intercept player + timedtext responses.
  const origFetch = window.fetch;
  window.fetch = async function (this: any, ...args: any[]) {
    const res = await origFetch.apply(this, args as any);
    try {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url ?? "";
      if (url.includes("/youtubei/v1/player")) {
        res.clone().json().then((j) => extractFromPlayerResponse(j)).catch(() => {});
      } else if (url.includes("/api/timedtext")) {
        res.clone().text().then((t) => onTimedtext(url, t)).catch(() => {});
      }
    } catch {
      /* ignore */
    }
    return res;
  } as typeof window.fetch;

  // YouTube sometimes loads timedtext via XHR; hook that too.
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string, ...rest: any[]) {
    if (typeof url === "string" && url.includes("/api/timedtext")) {
      this.addEventListener("load", () => {
        try {
          if (this.responseType === "" || this.responseType === "text") onTimedtext(url, this.responseText);
        } catch {
          /* ignore */
        }
      });
    }
    return (origOpen as any).apply(this, [method, url, ...rest]);
  } as typeof XMLHttpRequest.prototype.open;

  // 3) YouTube fires this on in-app navigation.
  window.addEventListener("yt-navigate-finish", () => setTimeout(tryInitial, 50) as any);

  // 4) Auto-enable captions on request from the content script, so YouTube fetches
  //    the timedtext (which we intercept) without the user clicking the CC button.
  function getPlayer(): any {
    return document.getElementById("movie_player") || document.querySelector(".html5-video-player");
  }
  function ensureCaptionsOn(lang: string): boolean {
    const player: any = getPlayer();
    if (player && typeof player.setOption === "function") {
      try {
        let list: any[] = [];
        try {
          list = player.getOption("captions", "tracklist") || [];
        } catch {
          /* module not ready */
        }
        if (list.length) {
          const norm = (s: string) => (s || "").toLowerCase().split("-")[0];
          const sameLang = list.filter((t) => norm(t.languageCode) === norm(lang));
          // Prefer a human-made track over the auto-generated (asr) one: it's
          // properly segmented and punctuated, so our cleaning has less to fix.
          const track =
            sameLang.find((t) => t.kind !== "asr") ||
            sameLang[0] ||
            list.find((t) => t.kind !== "asr") ||
            list[0];
          player.setOption("captions", "track", track);
          return true;
        }
      } catch {
        /* fall through to the button */
      }
    }
    // Fallback: toggle the CC button on (enables the default track).
    const btn = document.querySelector(".ytp-subtitles-button") as HTMLElement | null;
    if (btn) {
      const pressed = btn.getAttribute("aria-pressed");
      if (pressed === "false") {
        btn.click();
        return true;
      }
      if (pressed === "true") return true;
    }
    return false; // player not ready yet
  }

  let enableReq: { lang: string; tries: number } | null = null;
  function tryEnable() {
    if (!enableReq) return;
    if (ensureCaptionsOn(enableReq.lang)) {
      enableReq = null;
      return;
    }
    if (enableReq.tries++ < 24) setTimeout(tryEnable, 500);
    else enableReq = null;
  }
  window.addEventListener("message", (e) => {
    const d: any = e.data;
    if (d && d.source === "tnm-cmd" && d.cmd === "enableCaptions" && typeof d.lang === "string") {
      enableReq = { lang: d.lang, tries: 0 };
      if (typeof d.translateTo === "string") translateTo = d.translateTo;
      tryEnable();
      // The target track may already be captured (toggled translation on later) —
      // fetch its translation right away in that case.
      maybeFetchTranslation();
    }
  });
})();
