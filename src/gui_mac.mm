// gui_mac.mm – macOS implementation using Cocoa + WKWebView
// Requires -framework Cocoa -framework WebKit

#include "gui_window.h"

#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

#include <thread>
#include <atomic>
#include <string>

// ---------------------------------------------------------------------------
// Handle – stores references to the native window and thread state
// ---------------------------------------------------------------------------
struct GuiHandle {
    NSWindow* __strong          window;
    std::function<void()>       onClosed;
    std::thread                 uiThread;
    std::atomic<bool>           closed{false};
};

// ---------------------------------------------------------------------------
// WindowDelegate – detects when the user closes the window
// ---------------------------------------------------------------------------
@interface NodeGuiWindowDelegate : NSObject <NSWindowDelegate>
@property (nonatomic, assign) GuiHandle* handle;
@end

@implementation NodeGuiWindowDelegate
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

        // Delegate for close detection
        NodeGuiWindowDelegate* delegate = [[NodeGuiWindowDelegate alloc] init];
        delegate.handle = h;
        [window setDelegate:delegate];

        // Create WKWebView
        WKWebViewConfiguration* config = [[WKWebViewConfiguration alloc] init];
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

void* gui_open(const GuiOptions& opts, std::function<void()> onClosed) {
    auto* h = new GuiHandle();
    h->onClosed = std::move(onClosed);

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
