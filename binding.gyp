{
  "targets": [
    {
      "target_name": "node_gui",
      "sources": ["src/addon.cpp"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "defines": ["NAPI_VERSION=8", "NAPI_DISABLE_CPP_EXCEPTIONS"],
      "conditions": [
        [
          "OS=='linux'",
          {
            "sources": ["src/gui_linux.cpp"],
            "cflags_cc": [
              "-std=c++17",
              "-fPIC",
              "<!@(pkg-config --cflags gtk+-3.0 webkit2gtk-4.1)"
            ],
            "libraries": [
              "<!@(pkg-config --libs gtk+-3.0 webkit2gtk-4.1)"
            ]
          }
        ],
        [
          "OS=='mac'",
          {
            "sources": ["src/gui_mac.mm"],
            "cflags_cc": ["-std=c++17"],
            "xcode_settings": {
              "OTHER_CPLUSPLUSFLAGS": ["-std=c++17"],
              "OTHER_LDFLAGS": [
                "-framework Cocoa",
                "-framework WebKit"
              ],
              "MACOSX_DEPLOYMENT_TARGET": "11.0"
            }
          }
        ],
        [
          "OS=='win'",
          {
            "sources": ["src/gui_win.cpp"],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "AdditionalOptions": ["/std:c++17"]
              }
            },
            "libraries": [
              "user32.lib",
              "ole32.lib",
              "oleaut32.lib",
              "<(module_root_dir)/deps/webview2/lib/<(target_arch)/WebView2Loader.dll.lib"
            ],
            "include_dirs": [
              "deps/webview2/include"
            ],
            "copies": [
              {
                "destination": "<(PRODUCT_DIR)",
                "files": ["deps/webview2/lib/<(target_arch)/WebView2Loader.dll"]
              }
            ]
          }
        ]
      ]
    }
  ]
}
