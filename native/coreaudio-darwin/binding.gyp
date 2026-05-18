{
  "targets": [
    {
      "target_name": "coreaudio_darwin",
      "sources": [
        "src/addon.mm",
        "src/MicCapture.mm",
        "src/MicMonitor.mm",
        "src/DeviceChangeMonitor.mm",
        "src/GlobeKey.mm",
        "src/Paste.mm"
      ],
      "include_dirs": [
        "<!(node -p \"require('node-addon-api').include_dir\")"
      ],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "conditions": [
        ["OS=='mac'", {
          "xcode_settings": {
            "GCC_ENABLE_CPP_EXCEPTIONS": "NO",
            "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
            "MACOSX_DEPLOYMENT_TARGET": "14.2",
            "OTHER_CFLAGS": ["-fobjc-arc"],
            "OTHER_LDFLAGS": [
              "-framework", "AVFoundation",
              "-framework", "CoreAudio",
              "-framework", "AudioToolbox",
              "-framework", "ApplicationServices",
              "-framework", "Foundation"
            ]
          }
        }],
        ["OS!='mac'", {
          "sources": []
        }]
      ]
    }
  ]
}
