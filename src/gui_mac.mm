// gui_mac.mm – macOS implementation using Cocoa + WKWebView
// Requires -framework Cocoa -framework WebKit

#include "gui_window.h"
#include "gui_common.h"

#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

#include <thread>
#include <atomic>
#include <string>
#include <algorithm>
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
    std::function<void(const ContentSizeInfo&)> onSizeChanged;
    std::thread                 uiThread;
    std::atomic<bool>           closed{false};
    int64_t                     lastResizeMs{-1000000};
    int                         lastContentWidth{-1};
    int                         lastContentHeight{-1};
    bool                        hasPendingContentSize{false};
    int                         pendingContentWidth{0};
    int                         pendingContentHeight{0};
    uint64_t                    contentFlushGeneration{0};
    bool                        userResizing{false};
    uint64_t                    userResizeGeneration{0};
    uint64_t                    progResizeGeneration{0};
    ContentSizeInfo             lastInfo{};
    bool                        hasLastInfo{false};
    ContentSizeOptions          sizeOpts{};
    std::string                 sizeScriptStr;
    ResizeOptions               resizeOpts{};
    int                         initialOuterWidth{0};
    int                         initialOuterHeight{0};
};

static int handle_suppress_ms(GuiHandle* h) {
    if (!h) return 300;
    return std::max(0, h->sizeOpts.suppressDuringResizeMs);
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

static void queue_content_size_flush(GuiHandle* h, int width, int height) {
    if (!h) return;

    h->hasPendingContentSize = true;
    h->pendingContentWidth = std::max(0, width);
    h->pendingContentHeight = std::max(0, height);

    const int suppressMs = handle_suppress_ms(h);
    const int64_t elapsedMs = nowMs() - h->lastResizeMs;
    const int waitMs = (elapsedMs >= suppressMs)
        ? 1
        : static_cast<int>(suppressMs - elapsedMs);

    const uint64_t gen = ++h->contentFlushGeneration;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, static_cast<int64_t>(waitMs) * NSEC_PER_MSEC),
                   dispatch_get_main_queue(), ^{
        if (!h || h->contentFlushGeneration != gen || !h->hasPendingContentSize) return;

        const int64_t elapsedMsInner = nowMs() - h->lastResizeMs;
        if (elapsedMsInner < handle_suppress_ms(h)) {
            queue_content_size_flush(h, h->pendingContentWidth, h->pendingContentHeight);
            return;
        }

        const int pendingW = h->pendingContentWidth;
        const int pendingH = h->pendingContentHeight;
        h->hasPendingContentSize = false;
        emit_content_size_if_changed(h, pendingW, pendingH);
    });
}

static void schedule_user_resize_emit(GuiHandle* h) {
    if (!h || !h->sizeOpts.emitOnUserResize) return;
    const uint64_t gen = ++h->userResizeGeneration;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, static_cast<int64_t>(handle_suppress_ms(h)) * NSEC_PER_MSEC),
                   dispatch_get_main_queue(), ^{
        if (!h || h->userResizeGeneration != gen) return;
        h->userResizing = false;
        const int w = h->lastContentWidth >= 0 ? h->lastContentWidth : 0;
        const int hh = h->lastContentHeight >= 0 ? h->lastContentHeight : 0;
        emit_event(h, w, hh, ContentSizeInfo::Source::UserResize);
    });
}

static void schedule_programmatic_resize_emit(GuiHandle* h) {
    if (!h || !h->sizeOpts.emitOnProgrammaticResize) return;
    const uint64_t gen = ++h->progResizeGeneration;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, static_cast<int64_t>(handle_suppress_ms(h)) * NSEC_PER_MSEC),
                   dispatch_get_main_queue(), ^{
        if (!h || h->progResizeGeneration != gen) return;
        const int w = h->lastContentWidth >= 0 ? h->lastContentWidth : 0;
        const int hh = h->lastContentHeight >= 0 ? h->lastContentHeight : 0;
        emit_event(h, w, hh, ContentSizeInfo::Source::ProgrammaticResize);
    });
}

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
    if (!h) return;
    h->lastResizeMs = nowMs();
    h->userResizing = true;
    schedule_user_resize_emit(h);
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
        if (!h || !h->onSizeChanged) return;

        NSString* msg = (NSString*)message.body;
        int w = 0, ht = 0;
        ContentSizeInfo parsed{};
        if (!parse_ngsize_message([msg UTF8String], w, ht, parsed)) return;

        h->lastInfo = parsed;
        h->hasLastInfo = true;

        const int suppressMs = handle_suppress_ms(h);
        const int64_t elapsedMs = nowMs() - h->lastResizeMs;
        if (elapsedMs < suppressMs) {
            queue_content_size_flush(h, w, ht);
        } else {
            emit_content_size_if_changed(h, w, ht);
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

        NSString* sizeScriptSrc = [NSString stringWithUTF8String:h->sizeScriptStr.c_str()];
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

        // Apply user-resize constraints. NSWindow distinguishes inner (content)
        // and outer (frame) limits via separate setters.
        {
            const auto& ro = h->resizeOpts;
            NSRect curFrame = [window frame];
            h->initialOuterWidth  = (int)curFrame.size.width;
            h->initialOuterHeight = (int)curFrame.size.height;

            if (ro.innerSize.hasMinWidth || ro.innerSize.hasMinHeight) {
                NSSize cur = [window contentMinSize];
                NSSize s = NSMakeSize(
                    ro.innerSize.hasMinWidth  ? (CGFloat)ro.innerSize.minWidth  : cur.width,
                    ro.innerSize.hasMinHeight ? (CGFloat)ro.innerSize.minHeight : cur.height);
                [window setContentMinSize:s];
            }
            if (ro.innerSize.hasMaxWidth || ro.innerSize.hasMaxHeight) {
                NSSize s = NSMakeSize(
                    ro.innerSize.hasMaxWidth  ? (CGFloat)ro.innerSize.maxWidth  : CGFLOAT_MAX,
                    ro.innerSize.hasMaxHeight ? (CGFloat)ro.innerSize.maxHeight : CGFLOAT_MAX);
                [window setContentMaxSize:s];
            }
            if (ro.outerSize.hasMinWidth || ro.outerSize.hasMinHeight) {
                NSSize cur = [window minSize];
                NSSize s = NSMakeSize(
                    ro.outerSize.hasMinWidth  ? (CGFloat)ro.outerSize.minWidth  : cur.width,
                    ro.outerSize.hasMinHeight ? (CGFloat)ro.outerSize.minHeight : cur.height);
                [window setMinSize:s];
            }
            if (ro.outerSize.hasMaxWidth || ro.outerSize.hasMaxHeight) {
                NSSize s = NSMakeSize(
                    ro.outerSize.hasMaxWidth  ? (CGFloat)ro.outerSize.maxWidth  : CGFLOAT_MAX,
                    ro.outerSize.hasMaxHeight ? (CGFloat)ro.outerSize.maxHeight : CGFLOAT_MAX);
                [window setMaxSize:s];
            }
            // Axis lock: pin the locked axis at the initial outer dimension.
            if (ro.axis == "widthOnly") {
                NSSize lockedMin = NSMakeSize([window minSize].width,  curFrame.size.height);
                NSSize lockedMax = NSMakeSize([window maxSize].width,  curFrame.size.height);
                [window setMinSize:lockedMin];
                [window setMaxSize:lockedMax];
            } else if (ro.axis == "heightOnly") {
                NSSize lockedMin = NSMakeSize(curFrame.size.width, [window minSize].height);
                NSSize lockedMax = NSMakeSize(curFrame.size.width, [window maxSize].height);
                [window setMinSize:lockedMin];
                [window setMaxSize:lockedMax];
            }
        }

        // Run the event loop on this thread
        [NSApp run];
    }
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
    h->sizeScriptStr = build_size_script(sizeOpts);

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
            schedule_programmatic_resize_emit(h);
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
