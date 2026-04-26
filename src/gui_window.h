#ifndef GUI_WINDOW_H
#define GUI_WINDOW_H

#include <string>
#include <functional>

struct GuiOptions {
    int width;
    int height;
    int port;
};

// Limits for one rectangle (inner client area, or outer window frame).
// `hasXxx` flags indicate whether the user explicitly provided the field.
struct SizeLimits {
    bool hasMinWidth  = false; int minWidth  = 0;
    bool hasMaxWidth  = false; int maxWidth  = 0;
    bool hasMinHeight = false; int minHeight = 0;
    bool hasMaxHeight = false; int maxHeight = 0;
};

// Constraints applied while the user resizes the window with the mouse.
struct ResizeOptions {
    // 'both' | 'widthOnly' | 'heightOnly'
    // 'widthOnly'  -> height is locked at the initial value
    // 'heightOnly' -> width  is locked at the initial value
    std::string axis = "both";
    SizeLimits  innerSize; // limits applied to the inner client area (CSS px before scaling)
    SizeLimits  outerSize; // limits applied to the outer window frame
};

struct GuiDisplayArea {
    int left;
    int top;
    int width;
    int height;
};

// Configuration for content-size measurement and reporting.
struct ContentSizeOptions {
    // 'both' | 'width' | 'height' (which axes are reported as changing)
    std::string axes = "both";
    // 'auto' | 'stable' | 'stable-both' (CSS scrollbar-gutter applied to <html>)
    std::string scrollbarGutter = "stable";
    bool growOnly = false;
    bool shrinkOnly = false;
    int  minDelta = 1;          // ignore content changes smaller than this many CSS px on each axis
    int  debounceMs = 0;        // 0 = use rAF; >0 = setTimeout-based debounce in JS
    bool includeBodyMargin = true;
    int  suppressDuringResizeMs = 300; // native suppression window after a resize event
    bool emitOnUserResize = true;      // emit a synthetic event when the user finishes resizing the window
    bool emitOnProgrammaticResize = false; // emit after gui_resize() settles
};

// Information passed alongside the content size with each callback emission.
struct ContentSizeInfo {
    enum class Source { Content, UserResize, ProgrammaticResize };
    Source source = Source::Content;
    bool   userResizing = false;
    int    contentWidth = 0;    // measured content width  (CSS px)
    int    contentHeight = 0;   // measured content height (CSS px)
    int    windowWidth = 0;     // window inner width  (CSS px; equals window.innerWidth)
    int    windowHeight = 0;    // window inner height (CSS px; equals window.innerHeight)
    int    viewportWidth = 0;   // documentElement.clientWidth  (excludes vertical scrollbar)
    int    viewportHeight = 0;  // documentElement.clientHeight (excludes horizontal scrollbar)
    bool   verticalScrollbar = false;
    int    verticalScrollbarSize = 0;
    bool   horizontalScrollbar = false;
    int    horizontalScrollbarSize = 0;
    double devicePixelRatio = 1.0;
};

// Platform-specific functions implemented in gui_linux.cpp, gui_mac.mm, gui_win.cpp
// These run the webview on a dedicated GUI thread.

// Opens a native window with an embedded browser navigating to http://localhost:<port>.
// The onClosed callback is invoked (from the GUI thread) when the window is closed by the user.
// Returns an opaque handle used by gui_close().
void* gui_open(
    const GuiOptions& opts,
    const ContentSizeOptions& sizeOpts,
    const ResizeOptions& resizeOpts,
    std::function<void()> onClosed,
    std::function<void(const ContentSizeInfo&)> onSizeChanged
);

// Requests the window identified by handle to close. Thread-safe.
void gui_close(void* handle);

// Move the native window to screen coordinates (left, top).
void gui_move(void* handle, int left, int top);

// Resize the native window so its inner content area is (innerWidth, innerHeight).
void gui_resize(void* handle, int innerWidth, int innerHeight);

// Get the current primary display work area.
GuiDisplayArea gui_display_area();

#endif // GUI_WINDOW_H
