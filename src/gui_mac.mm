// gui_mac.mm – macOS implementation using Cocoa + WKWebView
// Requires -framework Cocoa -framework WebKit

#include "gui_window.h"

#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

#include <thread>
#include <atomic>
#include <string>
#include <cstdlib>
#include <chrono>
#include <cstdint>

// ---------------------------------------------------------------------------
// Handle – stores references to the native window and thread state
// ---------------------------------------------------------------------------
static int64_t nowMs() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

struct GuiHandle {
    NSWindow* __strong          window;
    std::function<void()>       onClosed;
    std::function<void(int, int)> onContentSizeChanged;
    std::thread                 uiThread;
    std::atomic<bool>           closed{false};
    int64_t                     lastResizeMs{-1000000};
    int                         lastContentWidth{-1};
    int                         lastContentHeight{-1};
};

// ---------------------------------------------------------------------------
// WindowDelegate – detects when the user closes the window
// ---------------------------------------------------------------------------
@interface NodeGuiWindowDelegate : NSObject <NSWindowDelegate>
@property (nonatomic, assign) GuiHandle* handle;
@end

@interface NodeGuiContentSizeHandler : NSObject <WKScriptMessageHandler>
@property (nonatomic, assign) GuiHandle* handle;
@end

@implementation NodeGuiWindowDelegate
- (void)windowDidResize:(NSNotification*)notification {
    GuiHandle* h = self.handle;
    if (h) h->lastResizeMs = nowMs();
}
- (void)windowWillClose:(NSNotification*)notification {
    GuiHandle* h = self.handle;
    if (h && !h->closed.exchange(true)) {
        if (h->onClosed) {
            h->onClosed();
        }
    }
    [NSApp stop:nil];
    // Post a dummy event to unblock [NSApp run]
    NSEvent* event = [NSEvent otherEventWithType:NSEventTypeApplicationDefined
                                        location:NSMakePoint(0, 0)
                                   modifierFlags:0
                                       timestamp:0
                                    windowNumber:0
                                         context:nil
                                         subtype:0
                                           data1:0
                                           data2:0];
    [NSApp postEvent:event atStart:YES];
}
@end

@implementation NodeGuiContentSizeHandler
- (void)userContentController:(WKUserContentController *)userContentController
            didReceiveScriptMessage:(WKScriptMessage *)message {
        (void)userContentController;
        if (![message.body isKindOfClass:[NSString class]]) return;
        GuiHandle* h = self.handle;
        if (!h || !h->onContentSizeChanged) return;
        // Suppress within 300 ms of any resize
        if (nowMs() - h->lastResizeMs < 300) return;

        NSString* msg = (NSString*)message.body;
        if (![msg hasPrefix:@"NGSIZE:"]) return;
        NSString* rest = [msg substringFromIndex:7];
        NSArray<NSString*>* parts = [rest componentsSeparatedByString:@"x"];
        if (parts.count != 2) return;
        int w = [parts[0] intValue];
        int ht = [parts[1] intValue];
        // Only fire when size actually changed
        if (w != h->lastContentWidth || ht != h->lastContentHeight) {
            h->lastContentWidth = w;
            h->lastContentHeight = ht;
            h->onContentSizeChanged(w, ht);
        }
}
@end

// ---------------------------------------------------------------------------
// GUI thread entry point
// ---------------------------------------------------------------------------
static void gui_thread_func(GuiOptions opts, GuiHandle* h) {
    @autoreleasepool {
        // Ensure NSApplication exists
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];

        // Create main window
        NSRect frame = NSMakeRect(0, 0, opts.width, opts.height);
        NSWindowStyleMask style = NSWindowStyleMaskTitled
                                | NSWindowStyleMaskClosable
                                | NSWindowStyleMaskResizable
                                | NSWindowStyleMaskMiniaturizable;

        NSWindow* window = [[NSWindow alloc] initWithContentRect:frame
                                                       styleMask:style
                                                         backing:NSBackingStoreBuffered
                                                           defer:NO];
        h->window = window;
        [window setTitle:@"node-gui"];
        [window center];

                const char* iconPath = std::getenv("NODE_GUI_WINDOW_ICON");
                if (iconPath && *iconPath) {
                        NSString* iconPathStr = [NSString stringWithUTF8String:iconPath];
                        NSImage* appIcon = [[NSImage alloc] initWithContentsOfFile:iconPathStr];
                        if (appIcon) {
                                [NSApp setApplicationIconImage:appIcon];
                                [window setMiniwindowImage:appIcon];
                        }
                }

        // Delegate for close detection
        NodeGuiWindowDelegate* delegate = [[NodeGuiWindowDelegate alloc] init];
        delegate.handle = h;
        [window setDelegate:delegate];

        // Create WKWebView
        WKWebViewConfiguration* config = [[WKWebViewConfiguration alloc] init];
        WKUserContentController* contentController = [[WKUserContentController alloc] init];
        NodeGuiContentSizeHandler* sizeHandler = [[NodeGuiContentSizeHandler alloc] init];
        sizeHandler.handle = h;
        [contentController addScriptMessageHandler:sizeHandler name:@"nodegui"];

        NSString* sizeScriptSrc =
            @"(() => {"
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
        WKUserScript* sizeScript = [[WKUserScript alloc] initWithSource:sizeScriptSrc
                                                           injectionTime:WKUserScriptInjectionTimeAtDocumentEnd
                                                        forMainFrameOnly:NO];
        [contentController addUserScript:sizeScript];
        config.userContentController = contentController;
        WKWebView* webview = [[WKWebView alloc] initWithFrame:frame configuration:config];
        [window setContentView:webview];

        // Navigate to localhost:<port>
        NSString* urlStr = [NSString stringWithFormat:@"http://localhost:%d", opts.port];
        NSURL* url = [NSURL URLWithString:urlStr];
        NSURLRequest* request = [NSURLRequest requestWithURL:url];
        [webview loadRequest:request];

        // Show the window
        [window makeKeyAndOrderFront:nil];
        [NSApp activateIgnoringOtherApps:YES];

        // Run the event loop on this thread
        [NSApp run];
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

void* gui_open(const GuiOptions& opts, std::function<void()> onClosed,
               std::function<void(int, int)> onContentSizeChanged) {
    auto* h = new GuiHandle();
    h->onClosed = std::move(onClosed);
    h->onContentSizeChanged = std::move(onContentSizeChanged);

    h->uiThread = std::thread(gui_thread_func, opts, h);
    h->uiThread.detach();

    return static_cast<void*>(h);
}

void gui_close(void* handle) {
    if (!handle) return;
    auto* h = static_cast<GuiHandle*>(handle);

    if (h->window) {
        dispatch_async(dispatch_get_main_queue(), ^{
            [h->window close];
        });
    }
}

void gui_move(void* handle, int left, int top) {
    if (!handle) return;
    auto* h = static_cast<GuiHandle*>(handle);
    if (h->window) {
        dispatch_async(dispatch_get_main_queue(), ^{
            [h->window setFrameTopLeftPoint:NSMakePoint(left, top)];
        });
    }
}

void gui_resize(void* handle, int innerWidth, int innerHeight) {
    if (!handle) return;
    auto* h = static_cast<GuiHandle*>(handle);
    if (h->window) {
        dispatch_async(dispatch_get_main_queue(), ^{
            h->lastResizeMs = nowMs();
            NSSize contentSize = NSMakeSize(innerWidth > 1 ? innerWidth : 1,
                                            innerHeight > 1 ? innerHeight : 1);
            [h->window setContentSize:contentSize];
        });
    }
}

GuiDisplayArea gui_display_area() {
    GuiDisplayArea area{0, 0, 0, 0};
    @autoreleasepool {
        NSScreen* screen = [NSScreen mainScreen];
        if (!screen) {
            NSArray<NSScreen*>* screens = [NSScreen screens];
            if (screens.count > 0) screen = screens[0];
        }
        if (screen) {
            NSRect visible = [screen visibleFrame];
            area.left = (int)visible.origin.x;
            area.top = (int)(visible.origin.y + visible.size.height);
            area.width = (int)visible.size.width;
            area.height = (int)visible.size.height;
        }
    }
    return area;
}
