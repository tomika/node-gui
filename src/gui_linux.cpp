// gui_linux.cpp – Linux implementation using GTK3 + WebKitGTK
#include "gui_window.h"
#include <gtk/gtk.h>
#include <webkit2/webkit2.h>
#include <thread>
#include <string>
#include <atomic>
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
    std::function<void(int, int)> onContentSizeChanged;
    std::thread             uiThread;
    std::atomic<bool>       closed{false};
    int64_t                 lastResizeMs{-1000000};
    int                     lastContentWidth{-1};
    int                     lastContentHeight{-1};
};

static int64_t nowMs() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

static gboolean on_configure_event(GtkWidget* /*widget*/, GdkEventConfigure* /*event*/, gpointer data) {
    auto* h = static_cast<GuiHandle*>(data);
    if (h) h->lastResizeMs = nowMs();
    return FALSE;
}

static void on_script_message(WebKitUserContentManager* /*manager*/,
                              WebKitJavascriptResult* js_result,
                              gpointer user_data) {
    auto* h = static_cast<GuiHandle*>(user_data);
    if (!h || !h->onContentSizeChanged) return;
    // Suppress within 300 ms of any resize
    if (nowMs() - h->lastResizeMs < 300) return;

    JSCValue* value = webkit_javascript_result_get_js_value(js_result);
    if (!jsc_value_is_string(value)) return;

    gchar* msg = jsc_value_to_string(value);
    if (!msg) return;

    int width = 0;
    int height = 0;
    if (sscanf(msg, "NGSIZE:%dx%d", &width, &height) == 2) {
        // Only fire when size actually changed
        if (width != h->lastContentWidth || height != h->lastContentHeight) {
            h->lastContentWidth = width;
            h->lastContentHeight = height;
            h->onContentSizeChanged(width, height);
        }
    }
    g_free(msg);
}

// Called on the GTK thread when the window is destroyed
static void on_destroy(GtkWidget* /*widget*/, gpointer data) {
    auto* h = static_cast<GuiHandle*>(data);
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

    // Create WebKit webview
    WebKitUserContentManager* manager = webkit_user_content_manager_new();
    webkit_user_content_manager_register_script_message_handler(manager, "nodegui");
    g_signal_connect(manager, "script-message-received::nodegui",
                     G_CALLBACK(on_script_message), h);

    WebKitWebView* webview = WEBKIT_WEB_VIEW(
        webkit_web_view_new_with_user_content_manager(manager)
    );
    gtk_container_add(GTK_CONTAINER(window), GTK_WIDGET(webview));

    const char* sizeScript =
        "(() => {"
        "  const post = () => {"
        "    const de = document.documentElement;"
        "    const body = document.body;"
        "    const w = Math.max((de && de.scrollWidth) || 0, (body && body.scrollWidth) || 0);"
        "    const h = Math.max((de && de.scrollHeight) || 0, (body && body.scrollHeight) || 0);"
        "    window.webkit.messageHandlers.nodegui.postMessage(`NGSIZE:${w}x${h}`);"
        "  };"
        "  new ResizeObserver(post).observe(document.documentElement);"
        "  window.addEventListener('load', post);"
        "  post();"
        "})();";
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
    }
    delete req;
    return G_SOURCE_REMOVE;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

void* gui_open(const GuiOptions& opts, std::function<void()> onClosed,
               std::function<void(int, int)> onContentSizeChanged) {
    auto* h = new GuiHandle();
    h->onClosed = std::move(onClosed);
    h->onContentSizeChanged = std::move(onContentSizeChanged);

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
