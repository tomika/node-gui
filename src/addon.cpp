#include <napi.h>
#include "gui_window.h"
#include <mutex>

// ---------------------------------------------------------------------------
// GuiWindow – N-API wrapper around the platform-specific gui_open / gui_close
// ---------------------------------------------------------------------------
class GuiWindow : public Napi::ObjectWrap<GuiWindow> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports) {
        Napi::Function func = DefineClass(env, "GuiWindow", {
            InstanceMethod("close", &GuiWindow::Close),
        });

        Napi::FunctionReference* ctor = new Napi::FunctionReference();
        *ctor = Napi::Persistent(func);
        env.SetInstanceData(ctor);

        exports.Set("GuiWindow", func);
        return exports;
    }

    // Constructor: new GuiWindow({ width, height, port, title })
    GuiWindow(const Napi::CallbackInfo& info)
        : Napi::ObjectWrap<GuiWindow>(info), handle_(nullptr) {

        Napi::Env env = info.Env();

        if (info.Length() < 1 || !info[0].IsObject()) {
            Napi::TypeError::New(env, "Expected options object { width, height, port }")
                .ThrowAsJavaScriptException();
            return;
        }

        Napi::Object opts = info[0].As<Napi::Object>();

        // Read required fields
        if (!opts.Has("width") || !opts.Has("height") || !opts.Has("port")) {
            Napi::TypeError::New(env, "Options must include width, height, and port")
                .ThrowAsJavaScriptException();
            return;
        }

        GuiOptions guiOpts;
        guiOpts.width  = opts.Get("width").As<Napi::Number>().Int32Value();
        guiOpts.height = opts.Get("height").As<Napi::Number>().Int32Value();
        guiOpts.port   = opts.Get("port").As<Napi::Number>().Int32Value();

        // Thread-safe function that prevents the N-API instance data from
        // being garbage-collected while the GUI thread is still running.
        // It is released in the onClosed callback when the window closes.
        tsfn_ = Napi::ThreadSafeFunction::New(
            env,
            Napi::Function(),           // No JS callback – used only for prevent GC
            "GuiWindowClose",           // Resource name
            0,                          // Max queue size (unlimited)
            1                           // Initial thread count
        );

        // Optional: store an 'onClose' callback
        if (opts.Has("onClose") && opts.Get("onClose").IsFunction()) {
            onCloseRef_ = Napi::Persistent(opts.Get("onClose").As<Napi::Function>());
            onCloseRef_.SuppressDestruct();
            hasOnClose_ = true;
        }

        // Create a persistent reference so this instance is stored for the callback
        closeTsfn_ = Napi::ThreadSafeFunction::New(
            env,
            hasOnClose_ ? onCloseRef_.Value() : Napi::Function::New(env, [](const Napi::CallbackInfo&){}),
            "GuiOnClose",
            0,
            1
        );

        // Open the native window on a background thread
        handle_ = gui_open(guiOpts, [this]() {
            // Called from the GUI thread when the window is closed
            std::lock_guard<std::mutex> lock(mutex_);
            handle_ = nullptr;
            if (closeTsfn_) {
                // Call the onClose JS function on the main thread
                closeTsfn_.BlockingCall();
                closeTsfn_.Release();
                closeTsfn_ = nullptr;
            }
            if (tsfn_) {
                tsfn_.Release();
                tsfn_ = nullptr;
            }
        });
    }

    // close() – request the native window to close
    Napi::Value Close(const Napi::CallbackInfo& info) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (handle_) {
            gui_close(handle_);
        }
        return info.Env().Undefined();
    }

private:
    void*                         handle_;
    std::mutex                    mutex_;
    Napi::ThreadSafeFunction      tsfn_;
    Napi::ThreadSafeFunction      closeTsfn_;
    Napi::FunctionReference       onCloseRef_;
    bool                          hasOnClose_ = false;
};

// ---------------------------------------------------------------------------
// Module init
// ---------------------------------------------------------------------------
Napi::Object Init(Napi::Env env, Napi::Object exports) {
    return GuiWindow::Init(env, exports);
}

NODE_API_MODULE(node_gui, Init)
