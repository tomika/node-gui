#include "gui_common.h"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <string>

namespace {
inline const char* axes_str(const std::string& a) {
    if (a == "width")  return "width";
    if (a == "height") return "height";
    return "both";
}
inline const char* gutter_str(const std::string& g) {
    if (g == "auto")        return "auto";
    if (g == "stable-both") return "stable-both";
    return "stable";
}
inline const char* boolean_str(bool b) { return b ? "true" : "false"; }
} // namespace

std::string build_size_script(const ContentSizeOptions& o) {
    std::string opts;
    opts.reserve(256);
    opts += "{axes:\"";  opts += axes_str(o.axes);   opts += "\"";
    opts += ",scrollbarGutter:\""; opts += gutter_str(o.scrollbarGutter); opts += "\"";
    opts += ",growOnly:";          opts += boolean_str(o.growOnly);
    opts += ",shrinkOnly:";        opts += boolean_str(o.shrinkOnly);
    opts += ",minDelta:";          opts += std::to_string(std::max(0, o.minDelta));
    opts += ",debounceMs:";        opts += std::to_string(std::max(0, o.debounceMs));
    opts += ",includeBodyMargin:"; opts += boolean_str(o.includeBodyMargin);
    opts += "}";

    static const char kBody[] = R"JS(
const POST = (m) => {
  try {
    if (typeof window !== 'undefined') {
      if (window.chrome && window.chrome.webview && window.chrome.webview.postMessage) {
        window.chrome.webview.postMessage(m); return;
      }
      if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.nodegui) {
        window.webkit.messageHandlers.nodegui.postMessage(m); return;
      }
    }
  } catch (_) {}
};
const toNum = v => Number.isFinite(v) ? v : 0;
const de = () => document.documentElement;
if (!window.__ngScrollbarGutterApplied && de()) {
  if (O.scrollbarGutter === 'stable')           de().style.scrollbarGutter = 'stable';
  else if (O.scrollbarGutter === 'stable-both') de().style.scrollbarGutter = 'stable both-edges';
  // 'auto' = leave default
  window.__ngScrollbarGutterApplied = true;
}
const measure = () => {
  const body = document.body, root = de();
  const dpr = window.devicePixelRatio || 1;
  const winW = window.innerWidth, winH = window.innerHeight;
  const vpW = root ? root.clientWidth  : winW;
  const vpH = root ? root.clientHeight : winH;
  const sV = Math.max(0, winW - vpW);
  const sH = Math.max(0, winH - vpH);
  let cW = 0, cH = 0;
  if (!body) {
    cW = root ? root.scrollWidth  : 0;
    cH = root ? root.scrollHeight : 0;
  } else {
    const cs = window.getComputedStyle(body);
    const pL = toNum(parseFloat(cs.paddingLeft)),  pT = toNum(parseFloat(cs.paddingTop));
    const pR = toNum(parseFloat(cs.paddingRight)), pB = toNum(parseFloat(cs.paddingBottom));
    const mL = O.includeBodyMargin ? toNum(parseFloat(cs.marginLeft))   : 0;
    const mT = O.includeBodyMargin ? toNum(parseFloat(cs.marginTop))    : 0;
    const mR = O.includeBodyMargin ? toNum(parseFloat(cs.marginRight))  : 0;
    const mB = O.includeBodyMargin ? toNum(parseFloat(cs.marginBottom)) : 0;
    const kids = body.children;
    let bW = 0, bH = 0;
    if (kids.length === 0) { bW = body.offsetWidth; bH = body.offsetHeight; }
    else {
      let minL = Infinity, minT = Infinity, maxR = -Infinity, maxB = -Infinity;
      for (let i = 0; i < kids.length; i++) {
        const r = kids[i].getBoundingClientRect();
        if (r.left   < minL) minL = r.left;
        if (r.top    < minT) minT = r.top;
        if (r.right  > maxR) maxR = r.right;
        if (r.bottom > maxB) maxB = r.bottom;
      }
      bW = Math.max(0, maxR - minL); bH = Math.max(0, maxB - minT);
    }
    cW = bW + pL + pR + mL + mR;
    cH = bH + pT + pB + mT + mB;
    if (root) {
      if (root.scrollWidth  > root.clientWidth ) cW = Math.max(cW, root.scrollWidth);
      if (root.scrollHeight > root.clientHeight) cH = Math.max(cH, root.scrollHeight);
    }
  }
  return {
    w: Math.max(0, Math.ceil(cW)),
    h: Math.max(0, Math.ceil(cH)),
    vw: Math.max(0, Math.ceil(vpW)),
    vh: Math.max(0, Math.ceil(vpH)),
    ww: Math.max(0, Math.ceil(winW)),
    wh: Math.max(0, Math.ceil(winH)),
    sv: sV > 0 ? 1 : 0, svs: Math.ceil(sV),
    sh: sH > 0 ? 1 : 0, shs: Math.ceil(sH),
    dpr: Math.round(dpr * 100)
  };
};
const state = window.__ngSizeState || {
  lastW: -1, lastH: -1, lastWw: -1, lastWh: -1, raf: 0, t: 0
};
const post = () => {
  state.raf = 0; state.t = 0;
  const s = measure();
  let w = s.w, h = s.h;
  if (O.axes === 'width'  && state.lastH >= 0) h = state.lastH;
  if (O.axes === 'height' && state.lastW >= 0) w = state.lastW;
  if (state.lastW >= 0 && state.lastH >= 0) {
    if (O.growOnly)   { if (w < state.lastW) w = state.lastW; if (h < state.lastH) h = state.lastH; }
    if (O.shrinkOnly) { if (w > state.lastW) w = state.lastW; if (h > state.lastH) h = state.lastH; }
    if (O.minDelta > 0) {
      if (Math.abs(w - state.lastW) < O.minDelta) w = state.lastW;
      if (Math.abs(h - state.lastH) < O.minDelta) h = state.lastH;
    }
  }
  // Also post when only the window/viewport size changed so the native side
  // can keep `info.windowWidth/Height` up to date even when content w/h are
  // pinned by the `axes` option or filtered by minDelta. The native side
  // suppresses the user callback when content size didn't actually change.
  if (w === state.lastW && h === state.lastH &&
      s.ww === state.lastWw && s.wh === state.lastWh) return;
  state.lastW = w; state.lastH = h;
  state.lastWw = s.ww; state.lastWh = s.wh;
  POST(`NGSIZE:${w},${h},${s.vw},${s.vh},${s.ww},${s.wh},${s.sv},${s.svs},${s.sh},${s.shs},${s.dpr}`);
};
const schedule = () => {
  if (O.debounceMs > 0) { if (state.t) clearTimeout(state.t); state.t = setTimeout(post, O.debounceMs); }
  else { if (state.raf) return; state.raf = requestAnimationFrame(post); }
};
if (!window.__ngSizeInstalled) {
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(schedule);
    if (de())          ro.observe(de());
    if (document.body) ro.observe(document.body);
    window.__ngSizeObs = ro;
  }
  const mo = new MutationObserver(schedule);
  if (de()) mo.observe(de(), { subtree: true, childList: true, attributes: true, characterData: true });
  window.__ngSizeMo = mo;
  window.addEventListener('load', schedule);
  window.addEventListener('resize', schedule);
  window.__ngSizeInstalled = true;
}
window.__ngSizeState = state;
schedule();
)JS";

    std::string s;
    s.reserve(sizeof(kBody) + 256);
    s += "(() => {\nconst O = ";
    s += opts;
    s += ";\n";
    s += kBody;
    s += "})();";
    return s;
}

bool parse_ngsize_message(const char* msg,
                          int& outWidth,
                          int& outHeight,
                          ContentSizeInfo& info) {
    if (!msg) return false;
    static const char kPrefix[] = "NGSIZE:";
    constexpr size_t kPrefixLen = sizeof(kPrefix) - 1;
    if (std::strncmp(msg, kPrefix, kPrefixLen) != 0) return false;

    int w = 0, h = 0, vw = 0, vh = 0, ww = 0, wh = 0;
    int sv = 0, svs = 0, sh = 0, shs = 0, dpr100 = 100;
    int n = std::sscanf(msg + kPrefixLen,
                        "%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d",
                        &w, &h, &vw, &vh, &ww, &wh,
                        &sv, &svs, &sh, &shs, &dpr100);
    if (n != 11) return false;

    outWidth  = w;
    outHeight = h;
    info.viewportWidth         = vw;
    info.viewportHeight        = vh;
    info.windowWidth           = ww;
    info.windowHeight          = wh;
    info.verticalScrollbar     = sv != 0;
    info.verticalScrollbarSize = svs;
    info.horizontalScrollbar   = sh != 0;
    info.horizontalScrollbarSize = shs;
    info.devicePixelRatio      = dpr100 > 0 ? (dpr100 / 100.0) : 1.0;
    return true;
}
