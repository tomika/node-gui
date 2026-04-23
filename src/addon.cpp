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
            InstanceMethod("move", &GuiWindow::Move),
            InstanceMethod("resize", &GuiWindow::Resize),
            StaticMethod("displayArea", &GuiWindow::DisplayArea),
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

        if (opts.Has("onContentSizeChanged") && opts.Get("onContentSizeChanged").IsFunction()) {
            onContentSizeRef_ = Napi::Persistent(opts.Get("onContentSizeChanged").As<Napi::Function>());
            onContentSizeRef_.SuppressDestruct();
            hasOnContentSize_ = true;
            contentSizeTsfn_ = Napi::ThreadSafeFunction::New(
                env,
                onContentSizeRef_.Value(),
                "GuiOnContentSizeChanged",
                0,
                1
            );
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
            if (contentSizeTsfn_) {
                contentSizeTsfn_.Release();
                contentSizeTsfn_ = nullptr;
            }
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
        }, [this](int width, int height) {
            std::lock_guard<std::mutex> lock(mutex_);
            if (!contentSizeTsfn_) return;

            struct ContentSizeData {
                int width;
                int height;
            };

            auto* payload = new ContentSizeData{width, height};
            auto status = contentSizeTsfn_.NonBlockingCall(
                payload,
                [](Napi::Env env, Napi::Function jsCb, ContentSizeData* data) {
                    jsCb.Call({
                        Napi::Number::New(env, data->width),
                        Napi::Number::New(env, data->height),
                    });
                    delete data;
                }
            );

            if (status != napi_ok) {
                delete payload;
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

    Napi::Value Move(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
            Napi::TypeError::New(env, "Expected move(left, top)").ThrowAsJavaScriptException();
            return env.Undefined();
        }

        const int left = info[0].As<Napi::Number>().Int32Value();
        const int top = info[1].As<Napi::Number>().Int32Value();
        std::lock_guard<std::mutex> lock(mutex_);
        if (handle_) {
            gui_move(handle_, left, top);
        }
        return env.Undefined();
    }

    Napi::Value Resize(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
            Napi::TypeError::New(env, "Expected resize(innerWidth, innerHeight)").ThrowAsJavaScriptException();
            return env.Undefined();
        }

        const int innerWidth = info[0].As<Napi::Number>().Int32Value();
        const int innerHeight = info[1].As<Napi::Number>().Int32Value();
        std::lock_guard<std::mutex> lock(mutex_);
        if (handle_) {
            gui_resize(handle_, innerWidth, innerHeight);
        }
        return env.Undefined();
    }

    static Napi::Value DisplayArea(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        GuiDisplayArea area = gui_display_area();
        Napi::Object out = Napi::Object::New(env);
        out.Set("left", Napi::Number::New(env, area.left));
        out.Set("top", Napi::Number::New(env, area.top));
        out.Set("width", Napi::Number::New(env, area.width));
        out.Set("height", Napi::Number::New(env, area.height));
        return out;
    }

private:
    void*                         handle_;
    std::mutex                    mutex_;
    Napi::ThreadSafeFunction      tsfn_;
    Napi::ThreadSafeFunction      closeTsfn_;
    Napi::ThreadSafeFunction      contentSizeTsfn_;
    Napi::FunctionReference       onCloseRef_;
    Napi::FunctionReference       onContentSizeRef_;
    bool                          hasOnClose_ = false;
    bool                          hasOnContentSize_ = false;
};

// ---------------------------------------------------------------------------
// Module init
// ---------------------------------------------------------------------------
Napi::Object Init(Napi::Env env, Napi::Object exports) {
    return GuiWindow::Init(env, exports);
}

NODE_API_MODULE(node_gui, Init)
