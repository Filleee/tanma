// Runs in YouTube's MAIN world (see manifest). Extracts caption-track metadata
// and posts it to the isolated content script via window.postMessage.
//
// IMPORTANT: this file must stay free of ES imports/exports — MV3 injects
// MAIN-world content scripts as classic scripts.

(function () {
  "use strict";

  const POST_SOURCE = "tnm-yt";
  function dbg(...a: any[]) {
    try {
      console.info("[tnm-yt]", ...a);
    } catch {
      /* ignore */
    }
  }
  let lastVideoId = "";
  // The last original (non-translated) timedtext request we saw — its POT token +
  // signature cover `tlang`, so we can re-issue it to fetch the auto-translation
  // even after the original was already captured (e.g. user toggles it on later).
  // Declared here (not lower) so extractFromPlayerResponse can reset them at load.
  let lastTargetUrl = "";
  let lastTargetLang = "";

  // Buffer the tracks + cue bodies we capture, so the content script can ask us to REPLAY them.
  // This inject runs in the MAIN world at document_start; the content-script listener comes up
  // later (document_idle). And YouTube serves cues from its own cache when the user toggles CC
  // off/on (no new network request for our fetch/XHR hook to see) — so a one-shot post can be
  // missed with no second chance. Replaying from this buffer closes both gaps.
  let bufTracks: { videoId: string; tracks: any[] } | null = null;
  const bufCaptions = new Map<string, { lang: string; asr: boolean; translated: boolean; body: string }>();

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
    bufTracks = { videoId, tracks };
    window.postMessage({ source: POST_SOURCE, kind: "tracks", videoId, tracks }, "*");
  }

  // Re-post everything captured for the current video (used when the content script asks, and after
  // an enableCaptions command) so late-starting or cache-blocked deliveries still land.
  // includeTracks=false when replaying in response to enableCaptions: re-posting `tracks` there would
  // make the content script send enableCaptions again → replay → tracks → … an infinite loop. Only the
  // explicit `replay` command (content startup) re-sends tracks.
  function replayBuffer(includeTracks: boolean) {
    if (includeTracks && bufTracks && bufTracks.videoId === lastVideoId) {
      window.postMessage({ source: POST_SOURCE, kind: "tracks", videoId: bufTracks.videoId, tracks: bufTracks.tracks }, "*");
    }
    for (const c of bufCaptions.values()) {
      window.postMessage(
        { source: POST_SOURCE, kind: "captionData", videoId: lastVideoId, lang: c.lang, asr: c.asr, translated: c.translated, body: c.body },
        "*",
      );
    }
  }

  // Fetch a caption track's own baseUrl directly (from the player response) instead of waiting for
  // YouTube to request it. Many tracks' baseUrls are fetchable as-is; feeding the result through
  // onTimedtext posts it as captionData. This is the reliable path when enabling captions doesn't
  // make YouTube fetch (e.g. asr-only videos where setOption/CC-click triggers no network request).
  // YouTube's timedtext endpoint answers 200 with an EMPTY body until the caption track is ready in
  // the player, so a single direct fetch usually misses on a fresh load. Retry quickly on an empty
  // body (cheap) instead of waiting for the content script's slow 2.5s enableCaptions tick — that's
  // what made loading "take a few tries". One chain at a time (guard) so requests don't stampede.
  let directFetching = false;
  function fetchTrackDirect(baseUrl: string, translateTo: string, tries = 0) {
    if (tries === 0) {
      if (directFetching) return;
      directFetching = true;
    }
    try {
      const u = new URL(baseUrl, location.href);
      if (!u.searchParams.get("fmt")) u.searchParams.set("fmt", "json3");
      if (translateTo) u.searchParams.set("tlang", translateTo);
      if (tries === 0) dbg("fetchTrackDirect", u.toString().slice(0, 140));
      window
        .fetch(u.toString())
        .then((r) => r.text())
        .then((t) => {
          if (t && t.length > 2) {
            directFetching = false;
            onTimedtext(u.toString(), t);
          } else if (tries < 6) {
            setTimeout(() => fetchTrackDirect(baseUrl, translateTo, tries + 1), 600); // empty → not ready yet
          } else {
            // Empty after retries usually means this track's baseUrl needs a token we don't have; the
            // OFF→ON caption toggle (which makes YouTube fetch itself) is the fallback that covers it.
            directFetching = false;
          }
        })
        .catch((e) => {
          directFetching = false;
          dbg("fetchTrackDirect failed", String(e));
        });
    } catch (e) {
      directFetching = false;
      dbg("fetchTrackDirect bad url", String(e));
    }
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
        bufTracks = null;
        bufCaptions.clear();
        directFetching = false;
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
    dbg("timedtext captured", { lang: effectiveLang, kind, tlang, bytes: body.length });
    // Buffer every captured body (keyed by effective language) so replayBuffer can re-deliver it,
    // even for the same body YouTube won't request again from the network.
    bufCaptions.set(effectiveLang, { lang: effectiveLang, asr: kind === "asr", translated: !!tlang, body });
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
      } else if (url.includes("timedtext")) {
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
    if (typeof url === "string" && url.includes("timedtext")) {
      this.addEventListener("load", () => {
        try {
          dbg("xhr timedtext", url.slice(0, 120));
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
          // A plain setOption to an already-selected track NO-OPS (YouTube makes no request, so our
          // hook captures nothing). Cycle OFF→ON to force a fresh timedtext fetch — this is exactly
          // what a manual CC off/on does, which is the path that reliably works.
          dbg("enable: cycle track off→on", track?.languageCode, track?.kind);
          try {
            player.setOption("captions", "track", {});
          } catch {
            /* ignore */
          }
          setTimeout(() => {
            try {
              player.setOption("captions", "track", track);
            } catch {
              /* ignore */
            }
          }, 200);
          return true;
        }
      } catch {
        /* fall through to the button */
      }
    }
    // Fallback: the CC button — cycle it off→on for the same forced re-fetch.
    const btn = document.querySelector(".ytp-subtitles-button") as HTMLElement | null;
    if (btn) {
      const pressed = btn.getAttribute("aria-pressed");
      if (pressed === "true") {
        btn.click(); // off
        setTimeout(() => btn.click(), 250); // on
        return true;
      }
      btn.click(); // was off (or unknown) → on
      return true;
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
    if (!d || d.source !== "tnm-cmd") return;
    if (d.cmd === "replay") {
      replayBuffer(true); // content script (re)connecting — hand it tracks + whatever cues we captured
      return;
    }
    if (d.cmd === "fetchTrack" && typeof d.baseUrl === "string") {
      fetchTrackDirect(d.baseUrl, typeof d.translateTo === "string" ? d.translateTo : "");
      return;
    }
    if (d.cmd === "enableCaptions" && typeof d.lang === "string") {
      enableReq = { lang: d.lang, tries: 0 };
      if (typeof d.translateTo === "string") translateTo = d.translateTo;
      tryEnable();
      // The target track may already be captured (toggled translation on later) —
      // fetch its translation right away in that case.
      maybeFetchTranslation();
      // …and re-deliver any buffered cues (NOT tracks — that would loop): on a cached CC toggle
      // YouTube fires no network request, so this is our chance to hand over what we already have.
      replayBuffer(false);
    }
  });
})();
