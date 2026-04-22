// gui_linux.cpp – Linux implementation using GTK3 + WebKitGTK
#include "gui_window.h"
#include <gtk/gtk.h>
#include <webkit2/webkit2.h>
#include <thread>
#include <string>
#include <atomic>
#include <mutex>
#include <cstdlib>

struct GuiHandle {
    GtkWidget*              window;
    std::function<void()>   onClosed;
    std::thread             uiThread;
    std::atomic<bool>       closed{false};
};

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

    // Create WebKit webview
    WebKitWebView* webview = WEBKIT_WEB_VIEW(webkit_web_view_new());
    gtk_container_add(GTK_CONTAINER(window), GTK_WIDGET(webview));

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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

void* gui_open(const GuiOptions& opts, std::function<void()> onClosed) {
    auto* h = new GuiHandle();
    h->onClosed = std::move(onClosed);

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
