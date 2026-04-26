// gui_linux.cpp – Linux implementation using GTK3 + WebKitGTK
#include "gui_window.h"
#include "gui_common.h"
#include <gtk/gtk.h>
#include <webkit2/webkit2.h>
#include <thread>
#include <string>
#include <atomic>
#include <algorithm>
#include <mutex>
#include <cstdlib>
#include <chrono>
#include <cstdint>

struct WindowSizeData {
    int width;
    int height;
};

struct GuiHandle {
    GtkWidget*              window;
    std::function<void()>   onClosed;
    std::function<void(const ContentSizeInfo&)> onSizeChanged;
    std::thread             uiThread;
    std::atomic<bool>       closed{false};
    int64_t                 lastResizeMs{-1000000};
    int                     lastContentWidth{-1};
    int                     lastContentHeight{-1};
    bool                    hasPendingContentSize{false};
    int                     pendingContentWidth{0};
    int                     pendingContentHeight{0};
    guint                   contentFlushSourceId{0};
    bool                    userResizing{false};
    guint                   userResizeIdleId{0};
    guint                   programmaticResizeIdleId{0};
    ContentSizeInfo         lastInfo{};
    bool                    hasLastInfo{false};
    ContentSizeOptions      sizeOpts{};
    std::string             sizeScript;
    ResizeOptions           resizeOpts{};
    int                     initialOuterWidth{0};
    int                     initialOuterHeight{0};
};

static int handle_suppress_ms(GuiHandle* h) {
    if (!h) return 300;
    return std::max(0, h->sizeOpts.suppressDuringResizeMs);
}

static int64_t nowMs() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

static void emit_event(GuiHandle* h, int width, int height, ContentSizeInfo::Source source) {
    if (!h || !h->onSizeChanged) return;
    width = std::max(0, width);
    height = std::max(0, height);
    if (source == ContentSizeInfo::Source::Content) {
        if (width == h->lastContentWidth && height == h->lastContentHeight) return;
    }
    h->lastContentWidth = width;
    h->lastContentHeight = height;
    ContentSizeInfo info = h->lastInfo;
    info.source = source;
    info.userResizing = h->userResizing;
    info.contentWidth = width;
    info.contentHeight = height;
    h->onSizeChanged(info);
}

static void emit_content_size_if_changed(GuiHandle* h, int width, int height) {
    emit_event(h, width, height, ContentSizeInfo::Source::Content);
}

static gboolean content_size_flush_cb(gpointer data) {
    auto* h = static_cast<GuiHandle*>(data);
    if (!h) return G_SOURCE_REMOVE;

    h->contentFlushSourceId = 0;
    if (!h->hasPendingContentSize) return G_SOURCE_REMOVE;

    const int suppressMs = handle_suppress_ms(h);
    const int64_t elapsedMs = nowMs() - h->lastResizeMs;
    if (elapsedMs < suppressMs) {
        const int waitMs = static_cast<int>(suppressMs - elapsedMs);
        h->contentFlushSourceId = g_timeout_add(waitMs, content_size_flush_cb, h);
        return G_SOURCE_REMOVE;
    }

    const int width = h->pendingContentWidth;
    const int height = h->pendingContentHeight;
    h->hasPendingContentSize = false;
    emit_content_size_if_changed(h, width, height);
    return G_SOURCE_REMOVE;
}

static void queue_content_size_flush(GuiHandle* h, int width, int height) {
    if (!h) return;

    h->hasPendingContentSize = true;
    h->pendingContentWidth = std::max(0, width);
    h->pendingContentHeight = std::max(0, height);

    if (h->contentFlushSourceId != 0) {
        g_source_remove(h->contentFlushSourceId);
        h->contentFlushSourceId = 0;
    }

    const int suppressMs = handle_suppress_ms(h);
    const int64_t elapsedMs = nowMs() - h->lastResizeMs;
    const int waitMs = (elapsedMs >= suppressMs)
        ? 1
        : static_cast<int>(suppressMs - elapsedMs);
    h->contentFlushSourceId = g_timeout_add(waitMs, content_size_flush_cb, h);
}

static gboolean user_resize_idle_cb(gpointer data) {
    auto* h = static_cast<GuiHandle*>(data);
    if (!h) return G_SOURCE_REMOVE;
    h->userResizeIdleId = 0;
    h->userResizing = false;
    if (h->sizeOpts.emitOnUserResize) {
        const int w = h->lastContentWidth >= 0 ? h->lastContentWidth : 0;
        const int hh = h->lastContentHeight >= 0 ? h->lastContentHeight : 0;
        emit_event(h, w, hh, ContentSizeInfo::Source::UserResize);
    }
    return G_SOURCE_REMOVE;
}

static gboolean programmatic_resize_idle_cb(gpointer data) {
    auto* h = static_cast<GuiHandle*>(data);
    if (!h) return G_SOURCE_REMOVE;
    h->programmaticResizeIdleId = 0;
    if (h->sizeOpts.emitOnProgrammaticResize) {
        const int w = h->lastContentWidth >= 0 ? h->lastContentWidth : 0;
        const int hh = h->lastContentHeight >= 0 ? h->lastContentHeight : 0;
        emit_event(h, w, hh, ContentSizeInfo::Source::ProgrammaticResize);
    }
    return G_SOURCE_REMOVE;
}

static gboolean on_configure_event(GtkWidget* /*widget*/, GdkEventConfigure* /*event*/, gpointer data) {
    auto* h = static_cast<GuiHandle*>(data);
    if (!h) return FALSE;
    h->lastResizeMs = nowMs();
    h->userResizing = true;
    if (h->userResizeIdleId != 0) {
        g_source_remove(h->userResizeIdleId);
    }
    h->userResizeIdleId = g_timeout_add(handle_suppress_ms(h), user_resize_idle_cb, h);
    return FALSE;
}

// Re-apply geometry hints once the window has been realized: at that point we
// know the real outer size (from gtk_window_get_size + frame extents) and can
// translate inner-size limits to outer-size limits accurately, plus pin the
// locked axis for axis = 'widthOnly' / 'heightOnly'.
static void apply_resize_constraints_after_realize(GtkWidget* widget, gpointer data) {
    auto* h = static_cast<GuiHandle*>(data);
    if (!h || !widget) return;

    GtkWindow* gw = GTK_WINDOW(widget);
    int outerW = 0, outerH = 0;
    gtk_window_get_size(gw, &outerW, &outerH);
    if (h->initialOuterWidth  == 0) h->initialOuterWidth  = outerW;
    if (h->initialOuterHeight == 0) h->initialOuterHeight = outerH;

    // Estimate chrome offset by comparing window size to webview allocation.
    GtkWidget* child = gtk_bin_get_child(GTK_BIN(widget));
    int chromeW = 0, chromeH = 0;
    if (child) {
        GtkAllocation alloc{};
        gtk_widget_get_allocation(child, &alloc);
        if (alloc.width > 0 && alloc.height > 0) {
            chromeW = std::max(0, outerW - alloc.width);
            chromeH = std::max(0, outerH - alloc.height);
        }
    }

    const auto& ro = h->resizeOpts;
    int minW = 1, minH = 1, maxW = G_MAXINT, maxH = G_MAXINT;
    if (ro.outerSize.hasMinWidth)  minW = std::max(minW, ro.outerSize.minWidth);
    if (ro.outerSize.hasMinHeight) minH = std::max(minH, ro.outerSize.minHeight);
    if (ro.outerSize.hasMaxWidth)  maxW = std::min(maxW, ro.outerSize.maxWidth);
    if (ro.outerSize.hasMaxHeight) maxH = std::min(maxH, ro.outerSize.maxHeight);
    if (ro.innerSize.hasMinWidth)  minW = std::max(minW, ro.innerSize.minWidth  + chromeW);
    if (ro.innerSize.hasMinHeight) minH = std::max(minH, ro.innerSize.minHeight + chromeH);
    if (ro.innerSize.hasMaxWidth)  maxW = std::min(maxW, ro.innerSize.maxWidth  + chromeW);
    if (ro.innerSize.hasMaxHeight) maxH = std::min(maxH, ro.innerSize.maxHeight + chromeH);

    if (ro.axis == "widthOnly"  && h->initialOuterHeight > 0) {
        minH = maxH = h->initialOuterHeight;
    } else if (ro.axis == "heightOnly" && h->initialOuterWidth > 0) {
        minW = maxW = h->initialOuterWidth;
    }

    bool haveAny = ro.outerSize.hasMinWidth || ro.outerSize.hasMinHeight ||
                   ro.outerSize.hasMaxWidth || ro.outerSize.hasMaxHeight ||
                   ro.innerSize.hasMinWidth || ro.innerSize.hasMinHeight ||
                   ro.innerSize.hasMaxWidth || ro.innerSize.hasMaxHeight ||
                   ro.axis != "both";
    if (!haveAny) return;

    GdkGeometry geom{};
    geom.min_width  = minW;
    geom.min_height = minH;
    geom.max_width  = maxW;
    geom.max_height = maxH;
    gtk_window_set_geometry_hints(gw, nullptr,
        &geom, (GdkWindowHints)(GDK_HINT_MIN_SIZE | GDK_HINT_MAX_SIZE));
}

static void on_script_message(WebKitUserContentManager* /*manager*/,
                              WebKitJavascriptResult* js_result,
                              gpointer user_data) {
    auto* h = static_cast<GuiHandle*>(user_data);
    if (!h || !h->onSizeChanged) return;

    JSCValue* value = webkit_javascript_result_get_js_value(js_result);
    if (!jsc_value_is_string(value)) return;

    gchar* msg = jsc_value_to_string(value);
    if (!msg) return;

    int width = 0, height = 0;
    ContentSizeInfo parsed{};
    if (parse_ngsize_message(msg, width, height, parsed)) {
        h->lastInfo = parsed;
        h->hasLastInfo = true;

        const int suppressMs = handle_suppress_ms(h);
        const int64_t elapsedMs = nowMs() - h->lastResizeMs;
        if (elapsedMs < suppressMs) {
            queue_content_size_flush(h, width, height);
        } else {
            emit_content_size_if_changed(h, width, height);
        }
    }
    g_free(msg);
}

// Called on the GTK thread when the window is destroyed
static void on_destroy(GtkWidget* /*widget*/, gpointer data) {
    auto* h = static_cast<GuiHandle*>(data);
    if (h->contentFlushSourceId != 0) {
        g_source_remove(h->contentFlushSourceId);
        h->contentFlushSourceId = 0;
    }
    if (h->userResizeIdleId != 0) {
        g_source_remove(h->userResizeIdleId);
        h->userResizeIdleId = 0;
    }
    if (h->programmaticResizeIdleId != 0) {
        g_source_remove(h->programmaticResizeIdleId);
        h->programmaticResizeIdleId = 0;
    }
    if (!h->closed.exchange(true)) {
        if (h->onClosed) {
            h->onClosed();
        }
    }
    gtk_main_quit();
}

// GTK thread entry point
static void gui_thread_func(GuiOptions opts, GuiHandle* h) {
    // gtk_init is safe to call more than once per the GTK docs, but we guard
    // it with a flag to avoid any edge-case issues across threads.
    static std::once_flag gtkInitFlag;
    std::call_once(gtkInitFlag, []() { gtk_init(nullptr, nullptr); });

    // Create window
    GtkWidget* window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
    h->window = window;
    gtk_window_set_title(GTK_WINDOW(window), "node-gui");
    gtk_window_set_default_size(GTK_WINDOW(window), opts.width, opts.height);
    gtk_window_set_position(GTK_WINDOW(window), GTK_WIN_POS_CENTER);

    const char* iconPath = std::getenv("NODE_GUI_WINDOW_ICON");
    if (iconPath && *iconPath) {
        gtk_window_set_icon_from_file(GTK_WINDOW(window), iconPath, nullptr);
    }

    g_signal_connect(window, "destroy", G_CALLBACK(on_destroy), h);
    g_signal_connect(window, "configure-event", G_CALLBACK(on_configure_event), h);
    g_signal_connect_after(window, "map",
                           G_CALLBACK(apply_resize_constraints_after_realize), h);

    // Apply user-resize constraints. GTK geometry hints apply to the whole
    // window (outer frame) when no geometry_widget is provided. Inner-size
    // limits are converted to outer by adding the chrome delta computed from
    // the current GtkWindow vs. webview allocation. We'll refine after the
    // window is realized; provide an initial best-effort set now.
    {
        const auto& ro = h->resizeOpts;
        GdkGeometry geom{};
        GdkWindowHints hintsMask = (GdkWindowHints)0;
        int minW = 1, minH = 1, maxW = G_MAXINT, maxH = G_MAXINT;
        if (ro.outerSize.hasMinWidth)  minW = std::max(minW, ro.outerSize.minWidth);
        if (ro.outerSize.hasMinHeight) minH = std::max(minH, ro.outerSize.minHeight);
        if (ro.outerSize.hasMaxWidth)  maxW = std::min(maxW, ro.outerSize.maxWidth);
        if (ro.outerSize.hasMaxHeight) maxH = std::min(maxH, ro.outerSize.maxHeight);
        // Inner limits: applied as-is here; refined post-realize via configure-event.
        if (ro.innerSize.hasMinWidth)  minW = std::max(minW, ro.innerSize.minWidth);
        if (ro.innerSize.hasMinHeight) minH = std::max(minH, ro.innerSize.minHeight);
        if (ro.innerSize.hasMaxWidth)  maxW = std::min(maxW, ro.innerSize.maxWidth);
        if (ro.innerSize.hasMaxHeight) maxH = std::min(maxH, ro.innerSize.maxHeight);

        bool haveAny = ro.outerSize.hasMinWidth || ro.outerSize.hasMinHeight ||
                       ro.outerSize.hasMaxWidth || ro.outerSize.hasMaxHeight ||
                       ro.innerSize.hasMinWidth || ro.innerSize.hasMinHeight ||
                       ro.innerSize.hasMaxWidth || ro.innerSize.hasMaxHeight ||
                       ro.axis != "both";
        if (haveAny) {
            geom.min_width  = minW;
            geom.min_height = minH;
            geom.max_width  = maxW;
            geom.max_height = maxH;
            hintsMask = (GdkWindowHints)(GDK_HINT_MIN_SIZE | GDK_HINT_MAX_SIZE);
            gtk_window_set_geometry_hints(GTK_WINDOW(window), nullptr, &geom, hintsMask);
        }
        // Axis lock is finalized once we know the realized outer size.
    }

    // Create WebKit webview
    WebKitUserContentManager* manager = webkit_user_content_manager_new();
    webkit_user_content_manager_register_script_message_handler(manager, "nodegui");
    g_signal_connect(manager, "script-message-received::nodegui",
                     G_CALLBACK(on_script_message), h);

    WebKitWebView* webview = WEBKIT_WEB_VIEW(
        webkit_web_view_new_with_user_content_manager(manager)
    );
    gtk_container_add(GTK_CONTAINER(window), GTK_WIDGET(webview));

    const char* sizeScript = h->sizeScript.c_str();
    WebKitUserScript* script = webkit_user_script_new(
        sizeScript,
        WEBKIT_USER_CONTENT_INJECT_ALL_FRAMES,
        WEBKIT_USER_SCRIPT_INJECT_AT_DOCUMENT_END,
        nullptr,
        nullptr
    );
    webkit_user_content_manager_add_script(manager, script);
    webkit_user_script_unref(script);

    // Navigate to localhost:<port>
    std::string url = "http://localhost:" + std::to_string(opts.port);
    webkit_web_view_load_uri(webview, url.c_str());

    gtk_widget_show_all(window);
    gtk_main();
}

// Close helper – invoked via g_idle_add on the GTK thread
static gboolean close_idle(gpointer data) {
    auto* h = static_cast<GuiHandle*>(data);
    if (h->window && GTK_IS_WIDGET(h->window)) {
        gtk_widget_destroy(h->window);
    }
    return G_SOURCE_REMOVE;
}

typedef struct {
    GuiHandle* handle;
    int left;
    int top;
} MoveData;

typedef struct {
    GuiHandle* handle;
    int innerWidth;
    int innerHeight;
} ResizeData;

static gboolean move_idle(gpointer data) {
    MoveData* req = static_cast<MoveData*>(data);
    if (req->handle && req->handle->window && GTK_IS_WIDGET(req->handle->window)) {
        gtk_window_move(GTK_WINDOW(req->handle->window), req->left, req->top);
    }
    delete req;
    return G_SOURCE_REMOVE;
}

static gboolean resize_idle(gpointer data) {
    ResizeData* req = static_cast<ResizeData*>(data);
    if (req->handle && req->handle->window && GTK_IS_WIDGET(req->handle->window)) {
        req->handle->lastResizeMs = nowMs();
        gtk_window_resize(GTK_WINDOW(req->handle->window),
                          req->innerWidth > 1 ? req->innerWidth : 1,
                          req->innerHeight > 1 ? req->innerHeight : 1);
        if (req->handle->sizeOpts.emitOnProgrammaticResize) {
            if (req->handle->programmaticResizeIdleId != 0) {
                g_source_remove(req->handle->programmaticResizeIdleId);
            }
            req->handle->programmaticResizeIdleId =
                g_timeout_add(handle_suppress_ms(req->handle),
                              programmatic_resize_idle_cb, req->handle);
        }
    }
    delete req;
    return G_SOURCE_REMOVE;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

void* gui_open(const GuiOptions& opts, const ContentSizeOptions& sizeOpts,
               const ResizeOptions& resizeOpts,
               std::function<void()> onClosed,
               std::function<void(const ContentSizeInfo&)> onSizeChanged) {
    auto* h = new GuiHandle();
    h->onClosed = std::move(onClosed);
    h->onSizeChanged = std::move(onSizeChanged);
    h->sizeOpts = sizeOpts;
    h->resizeOpts = resizeOpts;
    h->sizeScript = build_size_script(sizeOpts);

    // Launch the GUI on its own thread with its own GTK main loop
    h->uiThread = std::thread(gui_thread_func, opts, h);
    h->uiThread.detach();

    return static_cast<void*>(h);
}

void gui_close(void* handle) {
    if (!handle) return;
    auto* h = static_cast<GuiHandle*>(handle);
    // Post a close request to the GTK main loop
    g_idle_add(close_idle, h);
}

void gui_move(void* handle, int left, int top) {
    if (!handle) return;
    auto* h = static_cast<GuiHandle*>(handle);
    MoveData* req = new MoveData{h, left, top};
    g_idle_add(move_idle, req);
}

void gui_resize(void* handle, int innerWidth, int innerHeight) {
    if (!handle) return;
    auto* h = static_cast<GuiHandle*>(handle);
    ResizeData* req = new ResizeData{h, innerWidth, innerHeight};
    g_idle_add(resize_idle, req);
}

GuiDisplayArea gui_display_area() {
    static std::once_flag gtkInitFlag;
    std::call_once(gtkInitFlag, []() { gtk_init(nullptr, nullptr); });

    GuiDisplayArea area{0, 0, 0, 0};
    GdkDisplay* display = gdk_display_get_default();
    if (!display) return area;

    GdkMonitor* monitor = gdk_display_get_primary_monitor(display);
    if (!monitor) {
        monitor = gdk_display_get_monitor(display, 0);
        if (!monitor) return area;
    }

    GdkRectangle work;
    gdk_monitor_get_workarea(monitor, &work);
    area.left = work.x;
    area.top = work.y;
    area.width = work.width;
    area.height = work.height;
    return area;
}
