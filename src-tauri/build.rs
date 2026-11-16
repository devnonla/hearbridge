use std::env;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os == "macos" {
        let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
        let native = manifest.join("native");
        let lib = native.join("libapple_listen.a");
        let status = Command::new("bash")
            .arg(native.join("build-apple-listen.sh"))
            .arg(&lib)
            .status()
            .expect("run build-apple-listen.sh");
        assert!(status.success(), "native AppleListen build failed");

        println!("cargo:rustc-link-search=native={}", native.display());
        println!("cargo:rustc-link-lib=static=apple_listen");
        println!("cargo:rustc-link-lib=framework=Speech");
        println!("cargo:rustc-link-lib=framework=AVFoundation");
        println!("cargo:rustc-link-lib=framework=AudioToolbox");
        println!("cargo:rustc-link-lib=framework=CoreAudio");
        println!("cargo:rustc-link-lib=framework=CoreMedia");
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rustc-link-lib=framework=ApplicationServices");
        println!("cargo:rustc-link-lib=framework=CoreGraphics");
        println!("cargo:rustc-link-lib=framework=Accelerate");
        println!("cargo:rustc-link-lib=framework=Translation");
        println!("cargo:rustc-link-lib=framework=SwiftUI");
        println!("cargo:rustc-link-lib=objc");
        // Swift runtime (AppleSpeak / AppleTranslate)
        println!("cargo:rustc-link-lib=swiftCore");
        println!("cargo:rustc-link-lib=swiftSwiftOnoneSupport");
        println!("cargo:rustc-link-lib=swiftFoundation");
        println!("cargo:rustc-link-lib=swiftDarwin");
        println!("cargo:rustc-link-lib=swiftObjectiveC");
        println!("cargo:rustc-link-lib=swiftDispatch");
        println!("cargo:rustc-link-lib=swiftCoreFoundation");
        println!("cargo:rustc-link-lib=swiftIOKit");
        println!("cargo:rustc-link-lib=swiftXPC");
        println!("cargo:rustc-link-lib=swiftos");
        println!("cargo:rustc-link-lib=swiftsimd");
        println!("cargo:rustc-link-lib=swiftMetal");
        println!("cargo:rustc-link-lib=swiftCoreGraphics");
        println!("cargo:rustc-link-lib=swiftCoreImage");
        println!("cargo:rustc-link-lib=swiftQuartzCore");
        println!("cargo:rustc-link-lib=swiftAppKit");
        println!("cargo:rustc-link-lib=swiftAVFoundation");
        println!("cargo:rustc-link-lib=swift_Concurrency");
        println!("cargo:rustc-link-search=native=/usr/lib/swift");
        // dyld cần rpath để load libswift_*.dylib (@rpath từ Translation/SwiftUI)
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
        println!("cargo:rerun-if-changed=native/AppleListen.m");
        println!("cargo:rerun-if-changed=native/AppleListen.h");
        println!("cargo:rerun-if-changed=native/AppleSpeak.swift");
        println!("cargo:rerun-if-changed=native/AppleSpeak.h");
        println!("cargo:rerun-if-changed=native/AppleSiriTTS.m");
        println!("cargo:rerun-if-changed=native/AppleSiriTTS.h");
        println!("cargo:rerun-if-changed=native/AppleTranslate.swift");
        println!("cargo:rerun-if-changed=native/AppleTranslate.h");
        println!("cargo:rerun-if-changed=native/AppleApps.m");
        println!("cargo:rerun-if-changed=native/AppleApps.h");
        println!("cargo:rerun-if-changed=native/build-apple-listen.sh");
    }

    tauri_build::build()
}
