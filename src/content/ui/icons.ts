import { svg } from "./dom";

const stroke = 'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const fill = 'fill="currentColor"';

export const icons = {
  play: () => svg(`<path ${fill} d="M8 5v14l11-7z"/>`),
  pause: () => svg(`<path ${fill} d="M6 5h4v14H6zM14 5h4v14h-4z"/>`),
  prev: () => svg(`<path ${fill} d="M7 5h2v14H7zM20 5v14l-9-7z"/>`),
  next: () => svg(`<path ${fill} d="M15 5h2v14h-2zM4 5l9 7-9 7z"/>`),
  replay: () =>
    svg(
      `<path ${stroke} d="M3 12a9 9 0 1 0 3-6.7"/><path ${stroke} d="M3 4v4h4"/>`,
    ),
  gear: () =>
    svg(
      `<circle cx="12" cy="12" r="3" ${stroke}/><path ${stroke} d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>`,
    ),
  list: () =>
    svg(`<path ${stroke} d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>`),
  eye: () =>
    svg(
      `<path ${stroke} d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3" ${stroke}/>`,
    ),
  eyeOff: () =>
    svg(
      `<path ${stroke} d="M9.9 5A10.9 10.9 0 0 1 12 5c6.5 0 10 7 10 7a18 18 0 0 1-3 3.7M6.6 6.6A18 18 0 0 0 2 12s3.5 7 10 7a10.9 10.9 0 0 0 4-.7"/><path ${stroke} d="m2 2 20 20"/>`,
    ),
  upload: () =>
    svg(
      `<path ${stroke} d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 9l5-5 5 5M12 4v12"/>`,
    ),
  grip: () =>
    svg(`<circle cx="9" cy="6" r="1.5" ${fill}/><circle cx="15" cy="6" r="1.5" ${fill}/><circle cx="9" cy="12" r="1.5" ${fill}/><circle cx="15" cy="12" r="1.5" ${fill}/><circle cx="9" cy="18" r="1.5" ${fill}/><circle cx="15" cy="18" r="1.5" ${fill}/>`),
  close: () => svg(`<path ${stroke} d="M18 6 6 18M6 6l12 12"/>`),
  plus: () => svg(`<path ${stroke} d="M12 5v14M5 12h14"/>`),
  check: () => svg(`<path ${stroke} d="M20 6 9 17l-5-5"/>`),
  power: () =>
    svg(`<path ${stroke} d="M12 2v10M18.4 6.6a9 9 0 1 1-12.8 0"/>`),
  star: () =>
    svg(
      `<path ${fill} d="m12 17.3-6.2 3.7 1.6-7-5.4-4.7 7.1-.6L12 2l2.9 6.7 7.1.6-5.4 4.7 1.6 7z"/>`,
    ),
  sound: () =>
    svg(
      `<path ${stroke} d="M11 5 6 9H2v6h4l5 4V5z"/><path ${stroke} d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14"/>`,
    ),
  // circular arrows: re-detect / refresh
  refresh: () =>
    svg(
      `<path ${stroke} d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/>`,
    ),
  // cloud + magnifier: search jimaku.cc for subtitles
  jimaku: () =>
    svg(
      `<path ${stroke} d="M7 18a4 4 0 0 1-.5-7.97A5.5 5.5 0 0 1 17 9.5a3.5 3.5 0 0 1 1 6.86"/><circle cx="10.5" cy="14.5" r="2.5" ${stroke}/><path ${stroke} d="m13 17 2.5 2.5"/>`,
    ),
  // music note: find song lyrics (LRCLIB)
  lyrics: () =>
    svg(
      `<path ${stroke} d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3" ${stroke}/><circle cx="18" cy="16" r="3" ${stroke}/>`,
    ),
  // crosshair/target: align (sync) subtitle timing to this line at the current playhead
  sync: () =>
    svg(
      `<circle cx="12" cy="12" r="4" ${stroke}/><path ${stroke} d="M12 2v4M12 18v4M2 12h4M18 12h4"/>`,
    ),
  // list with a plus: add this word to the mining queue
  queue: () =>
    svg(`<path ${stroke} d="M4 6h11M4 12h11M4 18h7M18 15v6M15 18h6"/>`),
  // stacked layers: the mining queue itself
  stack: () =>
    svg(`<path ${stroke} d="m12 3 9 5-9 5-9-5 9-5zM3 13l9 5 9-5"/>`),
};
