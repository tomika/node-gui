// gui_win.cpp – Windows implementation using WebView2 (Edge Chromium)
// Requires WebView2Loader.dll and the WebView2 SDK headers.

#include "gui_window.h"
#include "gui_common.h"

#ifdef _WIN32

#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif

#include <windows.h>
#include <wrl.h>
#include <string>
#include <thread>
#include <atomic>
#include <functional>
#include <algorithm>
#include <chrono>
#include <cstdint>
#include <climits>

// WebView2 headers (from the Microsoft.Web.WebView2 NuGet package)
#include "WebView2.h"

using namespace Microsoft::WRL;

// ---------------------------------------------------------------------------
// Handle
// ---------------------------------------------------------------------------
static int64_t nowMs() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

static const UINT_PTR kContentFlushTimerId = 0x4E47;
static const UINT_PTR kUserResizeTimerId   = 0x4E48;
static const UINT_PTR kProgResizeTimerId   = 0x4E49;

struct GuiHandle {
    HWND                    hwnd   = nullptr;
    DWORD                   threadId = 0;
    std::function<void()>   onClosed;
    std::function<void(const ContentSizeInfo&)> onSizeChanged;
    std::thread             uiThread;
    std::atomic<bool>       closed{false};
    bool                    userResizing{false};
    int64_t                 lastResizeMs{-1000000};
    int                     lastContentWidth{-1};
    int                     lastContentHeight{-1};
    bool                    hasPendingContentSize{false};
    int                     pendingContentWidth{0};
    int                     pendingContentHeight{0};
    // Latest info reported by the injected JS measurement
    ContentSizeInfo         lastInfo{};
    bool                    hasLastInfo{false};
    // Configuration
    ContentSizeOptions      sizeOpts{};
    std::wstring            sizeScript;
    // User-resize constraints
    ResizeOptions           resizeOpts{};
    int                     initialOuterWidth{0};
    int                     initialOuterHeight{0};
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

static void queue_content_size_flush(HWND hwnd, GuiHandle* h, int width, int height) {
    if (!h || !hwnd) return;

    h->hasPendingContentSize = true;
    h->pendingContentWidth = std::max(0, width);
    h->pendingContentHeight = std::max(0, height);

    const int suppressMs = handle_suppress_ms(h);
    const int64_t elapsedMs = nowMs() - h->lastResizeMs;
    const int waitMs = (elapsedMs >= suppressMs)
        ? 1
        : static_cast<int>(suppressMs - elapsedMs);
    SetTimer(hwnd, kContentFlushTimerId, waitMs, nullptr);
}

// ---------------------------------------------------------------------------
// Script builder (UTF-8 -> wide for WebView2)
// ---------------------------------------------------------------------------
static std::wstring utf8_to_wide(const std::string& s) {
    if (s.empty()) return std::wstring();
    int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
    std::wstring out(static_cast<size_t>(n), L'\0');
    if (n > 0) {
        MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()),
                            out.data(), n);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Window class name
// ---------------------------------------------------------------------------
static const wchar_t* const kClassName = L"NodeGuiWindow";
static const wchar_t* const kWindowIconEnv = L"NODE_GUI_WINDOW_ICON";
static const UINT WM_APP_MOVE_WINDOW = WM_APP + 1;
static const UINT WM_APP_RESIZE_CONTENT = WM_APP + 2;

struct MoveRequest {
    int left;
    int top;
};

struct ResizeRequest {
    int innerWidth;
    int innerHeight;
};

static HICON load_window_icon_from_env(int cx, int cy) {
    wchar_t iconPath[MAX_PATH] = {0};
    DWORD len = GetEnvironmentVariableW(kWindowIconEnv, iconPath, MAX_PATH);
    if (len == 0 || len >= MAX_PATH) {
        return nullptr;
    }

    return static_cast<HICON>(LoadImageW(
        nullptr,
        iconPath,
        IMAGE_ICON,
        cx,
        cy,
        LR_LOADFROMFILE
    ));
}

// ---------------------------------------------------------------------------
// Window procedure
// ---------------------------------------------------------------------------
static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    auto* h = reinterpret_cast<GuiHandle*>(GetWindowLongPtr(hwnd, GWLP_USERDATA));

    switch (msg) {
    case WM_GETMINMAXINFO: {
        if (!h) return DefWindowProc(hwnd, msg, wParam, lParam);
        auto* mmi = reinterpret_cast<MINMAXINFO*>(lParam);

        // Compute the non-client overhead so we can convert inner-size limits
        // to outer-size limits on the fly. AdjustWindowRectEx with a 0x0 rect
        // returns the chrome offsets (negative left/top, positive right/bottom).
        DWORD style   = static_cast<DWORD>(GetWindowLongPtr(hwnd, GWL_STYLE));
        DWORD exStyle = static_cast<DWORD>(GetWindowLongPtr(hwnd, GWL_EXSTYLE));
        RECT chrome = {0, 0, 0, 0};
        AdjustWindowRectEx(&chrome, style, FALSE, exStyle);
        const int chromeW = (chrome.right - chrome.left);
        const int chromeH = (chrome.bottom - chrome.top);

        long minOuterW = 0, minOuterH = 0;
        long maxOuterW = LONG_MAX, maxOuterH = LONG_MAX;

        const auto& outer = h->resizeOpts.outerSize;
        if (outer.hasMinWidth)  minOuterW = std::max<long>(minOuterW, outer.minWidth);
        if (outer.hasMinHeight) minOuterH = std::max<long>(minOuterH, outer.minHeight);
        if (outer.hasMaxWidth)  maxOuterW = std::min<long>(maxOuterW, outer.maxWidth);
        if (outer.hasMaxHeight) maxOuterH = std::min<long>(maxOuterH, outer.maxHeight);

        const auto& inner = h->resizeOpts.innerSize;
        if (inner.hasMinWidth)  minOuterW = std::max<long>(minOuterW, inner.minWidth  + chromeW);
        if (inner.hasMinHeight) minOuterH = std::max<long>(minOuterH, inner.minHeight + chromeH);
        if (inner.hasMaxWidth)  maxOuterW = std::min<long>(maxOuterW, inner.maxWidth  + chromeW);
        if (inner.hasMaxHeight) maxOuterH = std::min<long>(maxOuterH, inner.maxHeight + chromeH);

        // Axis lock: pin the locked axis to the initial outer dimension.
        if (h->resizeOpts.axis == "widthOnly" && h->initialOuterHeight > 0) {
            minOuterH = maxOuterH = h->initialOuterHeight;
        } else if (h->resizeOpts.axis == "heightOnly" && h->initialOuterWidth > 0) {
            minOuterW = maxOuterW = h->initialOuterWidth;
        }

        if (minOuterW > 0)            mmi->ptMinTrackSize.x = minOuterW;
        if (minOuterH > 0)            mmi->ptMinTrackSize.y = minOuterH;
        if (maxOuterW != LONG_MAX)    mmi->ptMaxTrackSize.x = maxOuterW;
        if (maxOuterH != LONG_MAX)    mmi->ptMaxTrackSize.y = maxOuterH;
        return 0;
    }
    case WM_ENTERSIZEMOVE:
        if (h) { h->userResizing = true; h->lastResizeMs = nowMs(); }
        return DefWindowProc(hwnd, msg, wParam, lParam);
    case WM_EXITSIZEMOVE:
        if (h) {
            h->userResizing = false;
            h->lastResizeMs = nowMs();
            if (h->sizeOpts.emitOnUserResize) {
                SetTimer(hwnd, kUserResizeTimerId, handle_suppress_ms(h), nullptr);
            }
        }
        return DefWindowProc(hwnd, msg, wParam, lParam);
    case WM_SIZE: {
        // Resize the webview controller to match the window
        auto* ctrl = reinterpret_cast<ICoreWebView2Controller*>(
            GetPropW(hwnd, L"WebView2Controller"));
        if (ctrl) {
            RECT bounds;
            GetClientRect(hwnd, &bounds);
            ctrl->put_Bounds(bounds);
        }
        // Keep suppression timer rolling during user drag
        if (h && h->userResizing) h->lastResizeMs = nowMs();
        return 0;
    }
    case WM_TIMER:
        if (wParam == kContentFlushTimerId) {
            KillTimer(hwnd, kContentFlushTimerId);
            if (!h || !h->hasPendingContentSize) return 0;

            const int suppressMs = handle_suppress_ms(h);
            const int64_t elapsedMs = nowMs() - h->lastResizeMs;
            if (h->userResizing || elapsedMs < suppressMs) {
                const int waitMs = h->userResizing
                    ? suppressMs
                    : static_cast<int>(suppressMs - elapsedMs);
                SetTimer(hwnd, kContentFlushTimerId, waitMs, nullptr);
                return 0;
            }

            const int width = h->pendingContentWidth;
            const int height = h->pendingContentHeight;
            h->hasPendingContentSize = false;
            emit_content_size_if_changed(h, width, height);
            return 0;
        }
        if (wParam == kUserResizeTimerId) {
            KillTimer(hwnd, kUserResizeTimerId);
            if (!h) return 0;
            const int w = h->lastContentWidth >= 0 ? h->lastContentWidth : 0;
            const int hh = h->lastContentHeight >= 0 ? h->lastContentHeight : 0;
            emit_event(h, w, hh, ContentSizeInfo::Source::UserResize);
            return 0;
        }
        if (wParam == kProgResizeTimerId) {
            KillTimer(hwnd, kProgResizeTimerId);
            if (!h) return 0;
            const int w = h->lastContentWidth >= 0 ? h->lastContentWidth : 0;
            const int hh = h->lastContentHeight >= 0 ? h->lastContentHeight : 0;
            emit_event(h, w, hh, ContentSizeInfo::Source::ProgrammaticResize);
            return 0;
        }
        return DefWindowProc(hwnd, msg, wParam, lParam);
    case WM_CLOSE:
        DestroyWindow(hwnd);
        return 0;
    case WM_APP_MOVE_WINDOW: {
        auto* req = reinterpret_cast<MoveRequest*>(lParam);
        if (req) {
            SetWindowPos(hwnd, nullptr, req->left, req->top, 0, 0,
                         SWP_NOZORDER | SWP_NOSIZE | SWP_NOACTIVATE);
            delete req;
        }
        return 0;
    }
    case WM_APP_RESIZE_CONTENT: {
        auto* req = reinterpret_cast<ResizeRequest*>(lParam);
        if (req) {
            RECT rc = {0, 0,
                std::max(1, req->innerWidth),
                std::max(1, req->innerHeight)};
            DWORD style = static_cast<DWORD>(GetWindowLongPtr(hwnd, GWL_STYLE));
            DWORD exStyle = static_cast<DWORD>(GetWindowLongPtr(hwnd, GWL_EXSTYLE));
            AdjustWindowRectEx(&rc, style, FALSE, exStyle);
            int outerW = rc.right - rc.left;
            int outerH = rc.bottom - rc.top;
            // Record programmatic resize time before SetWindowPos (which triggers WM_SIZE)
            if (h) h->lastResizeMs = nowMs();
            SetWindowPos(hwnd, nullptr, 0, 0, outerW, outerH,
                         SWP_NOZORDER | SWP_NOMOVE | SWP_NOACTIVATE);
            if (h && h->sizeOpts.emitOnProgrammaticResize) {
                SetTimer(hwnd, kProgResizeTimerId, handle_suppress_ms(h), nullptr);
            }
            delete req;
        }
        return 0;
    }
    case WM_DESTROY:
        KillTimer(hwnd, kContentFlushTimerId);
        KillTimer(hwnd, kUserResizeTimerId);
        KillTimer(hwnd, kProgResizeTimerId);
        // Release WebView2 controller stored as a window property
        {
            auto* ctrl = reinterpret_cast<ICoreWebView2Controller*>(
                GetPropW(hwnd, L"WebView2Controller"));
            if (ctrl) {
                RemovePropW(hwnd, L"WebView2Controller");
                ctrl->Release();
            }
        }
        if (h && !h->closed.exchange(true)) {
            if (h->onClosed) {
                h->onClosed();
            }
        }
        PostQuitMessage(0);
        return 0;
    default:
        return DefWindowProc(hwnd, msg, wParam, lParam);
    }
}

// ---------------------------------------------------------------------------
// GUI thread
// ---------------------------------------------------------------------------
static void gui_thread_func(GuiOptions opts, GuiHandle* h) {
    HINSTANCE hInst = GetModuleHandle(nullptr);

    static HICON classIconLarge = nullptr;
    static HICON classIconSmall = nullptr;
    if (!classIconLarge) {
        classIconLarge = load_window_icon_from_env(
            GetSystemMetrics(SM_CXICON),
            GetSystemMetrics(SM_CYICON)
        );
    }
    if (!classIconSmall) {
        classIconSmall = load_window_icon_from_env(
            GetSystemMetrics(SM_CXSMICON),
            GetSystemMetrics(SM_CYSMICON)
        );
    }

    // Register window class (once per process)
    static ATOM classAtom = 0;
    if (!classAtom) {
        WNDCLASSEXW wc = {};
        wc.cbSize        = sizeof(wc);
        wc.lpfnWndProc   = WndProc;
        wc.hInstance      = hInst;
        wc.lpszClassName  = kClassName;
        wc.hCursor        = LoadCursor(nullptr, IDC_ARROW);
        wc.hbrBackground  = (HBRUSH)(COLOR_WINDOW + 1);
        wc.hIcon          = classIconLarge;
        wc.hIconSm        = classIconSmall;
        classAtom = RegisterClassExW(&wc);
    }

    // Create window (title will be set by WebView2 DocumentTitleChanged)
    HWND hwnd = CreateWindowExW(
        0, kClassName, L"node-gui",
        WS_OVERLAPPEDWINDOW,
        CW_USEDEFAULT, CW_USEDEFAULT,
        opts.width, opts.height,
        nullptr, nullptr, hInst, nullptr);

    h->hwnd     = hwnd;
    h->threadId = GetCurrentThreadId();
    SetWindowLongPtr(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(h));

    // Record initial outer dimensions for axis-lock support (must be after the
    // window exists so the actual frame includes any DPI/border adjustments).
    {
        RECT wr{};
        GetWindowRect(hwnd, &wr);
        h->initialOuterWidth  = wr.right  - wr.left;
        h->initialOuterHeight = wr.bottom - wr.top;
    }

    // Ensure icon is applied even if class icon is unavailable/unchanged.
    if (classIconLarge) {
        SendMessageW(hwnd, WM_SETICON, ICON_BIG, reinterpret_cast<LPARAM>(classIconLarge));
    }
    if (classIconSmall) {
        SendMessageW(hwnd, WM_SETICON, ICON_SMALL, reinterpret_cast<LPARAM>(classIconSmall));
    }

    ShowWindow(hwnd, SW_SHOW);
    UpdateWindow(hwnd);

    // Initialize WebView2
    std::string url = "http://localhost:" + std::to_string(opts.port);

    CreateCoreWebView2EnvironmentWithOptions(
        nullptr, nullptr, nullptr,
        Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
            [hwnd, url, h](HRESULT result, ICoreWebView2Environment* env) -> HRESULT {
                if (FAILED(result) || !env) return result;
                env->CreateCoreWebView2Controller(
                    hwnd,
                    Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                        [hwnd, url, h](HRESULT result, ICoreWebView2Controller* controller) -> HRESULT {
                            if (FAILED(result) || !controller) return result;

                            // Store controller reference for resize
                            SetPropW(hwnd, L"WebView2Controller", controller);
                            controller->AddRef();

                            RECT bounds;
                            GetClientRect(hwnd, &bounds);
                            controller->put_Bounds(bounds);

                            ComPtr<ICoreWebView2> webview;
                            controller->get_CoreWebView2(&webview);

                            // Register message handler BEFORE Navigate so no messages are missed
                            EventRegistrationToken msgToken;
                            webview->add_WebMessageReceived(
                                Callback<ICoreWebView2WebMessageReceivedEventHandler>(
                                    [h](ICoreWebView2* /*sender*/, ICoreWebView2WebMessageReceivedEventArgs* args) -> HRESULT {
                                        if (!h || !h->onSizeChanged) return S_OK;
                                        LPWSTR msg = nullptr;
                                        if (FAILED(args->TryGetWebMessageAsString(&msg)) || !msg) return S_OK;

                                        // Convert wide -> UTF-8 for the shared parser.
                                        int n = WideCharToMultiByte(CP_UTF8, 0, msg, -1,
                                                                    nullptr, 0, nullptr, nullptr);
                                        std::string u8;
                                        if (n > 0) {
                                            u8.resize(static_cast<size_t>(n) - 1);
                                            WideCharToMultiByte(CP_UTF8, 0, msg, -1,
                                                                u8.data(), n, nullptr, nullptr);
                                        }
                                        int w = 0, ht = 0;
                                        ContentSizeInfo parsed{};
                                        if (parse_ngsize_message(u8.c_str(), w, ht, parsed)) {
                                            h->lastInfo = parsed;
                                            h->hasLastInfo = true;

                                            const int suppressMs = handle_suppress_ms(h);
                                            const int64_t elapsedMs = nowMs() - h->lastResizeMs;
                                            if (h->userResizing || elapsedMs < suppressMs) {
                                                queue_content_size_flush(h->hwnd, h, w, ht);
                                            } else {
                                                emit_content_size_if_changed(h, w, ht);
                                            }
                                        }
                                        CoTaskMemFree(msg);
                                        return S_OK;
                                    }).Get(),
                                &msgToken);

                            // After each navigation completes, inject the size-observer script
                            EventRegistrationToken navToken;
                            webview->add_NavigationCompleted(
                                Callback<ICoreWebView2NavigationCompletedEventHandler>(
                                    [h](ICoreWebView2* sender, ICoreWebView2NavigationCompletedEventArgs* /*args*/) -> HRESULT {
                                        if (h && !h->sizeScript.empty()) {
                                            sender->ExecuteScript(h->sizeScript.c_str(), nullptr);
                                        }
                                        return S_OK;
                                    }).Get(),
                                &navToken);

                            // Convert URL to wide string
                            int urlWLen = MultiByteToWideChar(CP_UTF8, 0, url.data(),
                                                              (int)url.size(), nullptr, 0);
                            std::wstring wUrl(urlWLen, L'\0');
                            MultiByteToWideChar(CP_UTF8, 0, url.data(),
                                                (int)url.size(), &wUrl[0], urlWLen);

                            webview->Navigate(wUrl.c_str());
                            controller->put_IsVisible(TRUE);

                            // Handle window.close() from JavaScript
                            EventRegistrationToken closeToken;
                            webview->add_WindowCloseRequested(
                                Callback<ICoreWebView2WindowCloseRequestedEventHandler>(
                                    [hwnd](ICoreWebView2* /*sender*/, IUnknown* /*args*/) -> HRESULT {
                                        PostMessage(hwnd, WM_CLOSE, 0, 0);
                                        return S_OK;
                                    }).Get(),
                                &closeToken);

                            // Sync window title with HTML <title>
                            EventRegistrationToken titleToken;
                            webview->add_DocumentTitleChanged(
                                Callback<ICoreWebView2DocumentTitleChangedEventHandler>(
                                    [hwnd](ICoreWebView2* sender, IUnknown* /*args*/) -> HRESULT {
                                        LPWSTR title = nullptr;
                                        if (SUCCEEDED(sender->get_DocumentTitle(&title)) && title) {
                                            SetWindowTextW(hwnd, title);
                                            CoTaskMemFree(title);
                                        }
                                        return S_OK;
                                    }).Get(),
                                &titleToken);

                            return S_OK;
                        }).Get());
                return S_OK;
            }).Get());

    // Message loop
    MSG msg;
    while (GetMessage(&msg, nullptr, 0, 0)) {
        TranslateMessage(&msg);
        DispatchMessage(&msg);
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
    h->sizeScript = utf8_to_wide(build_size_script(sizeOpts));

    h->uiThread = std::thread(gui_thread_func, opts, h);
    h->uiThread.detach();

    return static_cast<void*>(h);
}

void gui_close(void* handle) {
    if (!handle) return;
    auto* h = static_cast<GuiHandle*>(handle);
    if (h->hwnd) {
        PostMessage(h->hwnd, WM_CLOSE, 0, 0);
    }
}

void gui_move(void* handle, int left, int top) {
    if (!handle) return;
    auto* h = static_cast<GuiHandle*>(handle);
    if (h->hwnd) {
        auto* req = new MoveRequest{left, top};
        PostMessage(h->hwnd, WM_APP_MOVE_WINDOW, 0, reinterpret_cast<LPARAM>(req));
    }
}

void gui_resize(void* handle, int innerWidth, int innerHeight) {
    if (!handle) return;
    auto* h = static_cast<GuiHandle*>(handle);
    if (h->hwnd) {
        auto* req = new ResizeRequest{innerWidth, innerHeight};
        PostMessage(h->hwnd, WM_APP_RESIZE_CONTENT, 0, reinterpret_cast<LPARAM>(req));
    }
}

GuiDisplayArea gui_display_area() {
    RECT work = {0, 0, 0, 0};
    SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0);
    GuiDisplayArea area;
    area.left = work.left;
    area.top = work.top;
    area.width = work.right - work.left;
    area.height = work.bottom - work.top;
    return area;
}

#endif // _WIN32
