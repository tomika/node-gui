#ifndef GUI_COMMON_H
#define GUI_COMMON_H

#include "gui_window.h"
#include <string>

// Builds the per-window injected JavaScript with measurement & messaging
// logic. The returned UTF-8 string is identical on every platform; each
// platform converts it to its native string type before injecting.
//
// The script posts size events with `chrome.webview.postMessage` on Windows
// and `webkit.messageHandlers.nodegui.postMessage` on Linux/macOS. A small
// POST shim inside the script tries both paths so a single source-of-truth
// works everywhere.
std::string build_size_script(const ContentSizeOptions& opts);

// Parses a "NGSIZE:w,h,vw,vh,ww,wh,sv,svs,sh,shs,dpr100" message produced
// by the injected script and fills the size and ContentSizeInfo fields.
// `info.source` and `info.userResizing` are NOT set by this function — the
// caller decides how to tag the event.
//
// Returns true on a well-formed NGSIZE message, false otherwise.
bool parse_ngsize_message(const char* msg,
                          int& outWidth,
                          int& outHeight,
                          ContentSizeInfo& info);

#endif // GUI_COMMON_H
