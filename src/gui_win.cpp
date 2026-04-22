// gui_win.cpp – Windows implementation using WebView2 (Edge Chromium)
// Requires WebView2Loader.dll and the WebView2 SDK headers.

#include "gui_window.h"

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

// WebView2 headers (from the Microsoft.Web.WebView2 NuGet package)
#include "WebView2.h"

using namespace Microsoft::WRL;

// ---------------------------------------------------------------------------
// Handle
// ---------------------------------------------------------------------------
struct GuiHandle {
    HWND                    hwnd   = nullptr;
    DWORD                   threadId = 0;
    std::function<void()>   onClosed;
    std::thread             uiThread;
    std::atomic<bool>       closed{false};
};

// ---------------------------------------------------------------------------
// Window class name
// ---------------------------------------------------------------------------
static const wchar_t* const kClassName = L"NodeGuiWindow";
static const wchar_t* const kWindowIconEnv = L"NODE_GUI_WINDOW_ICON";

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
    case WM_SIZE: {
        // Resize the webview controller to match the window
        auto* ctrl = reinterpret_cast<ICoreWebView2Controller*>(
            GetPropW(hwnd, L"WebView2Controller"));
        if (ctrl) {
            RECT bounds;
            GetClientRect(hwnd, &bounds);
            ctrl->put_Bounds(bounds);
        }
        return 0;
    }
    case WM_CLOSE:
        DestroyWindow(hwnd);
        return 0;
    case WM_DESTROY:
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
            [hwnd, url](HRESULT result, ICoreWebView2Environment* env) -> HRESULT {
                if (FAILED(result) || !env) return result;
                env->CreateCoreWebView2Controller(
                    hwnd,
                    Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                        [hwnd, url](HRESULT result, ICoreWebView2Controller* controller) -> HRESULT {
                            if (FAILED(result) || !controller) return result;

                            // Store controller reference for resize
                            SetPropW(hwnd, L"WebView2Controller", controller);
                            controller->AddRef();

                            RECT bounds;
                            GetClientRect(hwnd, &bounds);
                            controller->put_Bounds(bounds);

                            ComPtr<ICoreWebView2> webview;
                            controller->get_CoreWebView2(&webview);

                            // Convert URL to wide string (explicit length, no null terminator)
                            int urlWLen = MultiByteToWideChar(CP_UTF8, 0, url.data(),
                                                              (int)url.size(), nullptr, 0);
                            std::wstring wUrl(urlWLen, L'\0');
                            MultiByteToWideChar(CP_UTF8, 0, url.data(),
                                                (int)url.size(), &wUrl[0], urlWLen);

                            webview->Navigate(wUrl.c_str());
                            controller->put_IsVisible(TRUE);

                            // Handle window.close() from JavaScript
                            EventRegistrationToken token;
                            webview->add_WindowCloseRequested(
                                Callback<ICoreWebView2WindowCloseRequestedEventHandler>(
                                    [hwnd](ICoreWebView2* /*sender*/, IUnknown* /*args*/) -> HRESULT {
                                        PostMessage(hwnd, WM_CLOSE, 0, 0);
                                        return S_OK;
                                    }).Get(),
                                &token);

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
    if (h->hwnd) {
        PostMessage(h->hwnd, WM_CLOSE, 0, 0);
    }
}

#endif // _WIN32
