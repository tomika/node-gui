#ifndef GUI_WINDOW_H
#define GUI_WINDOW_H

#include <string>
#include <functional>

struct GuiOptions {
    int width;
    int height;
    int port;
};

struct GuiDisplayArea {
    int left;
    int top;
    int width;
    int height;
};

// Platform-specific functions implemented in gui_linux.cpp, gui_mac.mm, gui_win.cpp
// These run the webview on a dedicated GUI thread.

// Opens a native window with an embedded browser navigating to http://localhost:<port>.
// The onClosed callback is invoked (from the GUI thread) when the window is closed by the user.
// Returns an opaque handle used by gui_close().
void* gui_open(
    const GuiOptions& opts,
    std::function<void()> onClosed,
    std::function<void(int, int)> onContentSizeChanged
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
