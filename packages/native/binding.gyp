{
  "targets": [
    {
      "target_name": "classroom_input",
      "include_dirs": [
        "<!(node -p \"require('path').dirname(require.resolve('node-addon-api'))\")"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS",
        "UNICODE",
        "_UNICODE",
        "NOMINMAX",
        "WIN32_LEAN_AND_MEAN"
      ],
      "conditions": [
        ["OS=='win'", {
          "sources": [
            "src/addon.cc",
            "src/win_input.cc",
            "src/win_hook.cc"
          ],
          "libraries": ["user32.lib"],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "AdditionalOptions": ["/std:c++17", "/permissive-", "/utf-8"]
            }
          }
        }],
        ["OS!='win'", {
          "sources": ["src/stub.cc"],
          "cflags_cc": ["-std=c++17"]
        }]
      ]
    }
  ]
}
