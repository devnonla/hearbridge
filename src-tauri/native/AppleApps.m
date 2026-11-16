#import "AppleApps.h"
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Foundation/Foundation.h>
#import <stdlib.h>

static char *nsdata_to_b64_c(NSData *data) {
  if (!data.length) return NULL;
  NSString *b64 = [data base64EncodedStringWithOptions:0];
  if (!b64.length) return NULL;
  const char *utf8 = b64.UTF8String;
  if (!utf8) return NULL;
  return strdup(utf8);
}

static NSData *nsimage_png(NSImage *image, CGFloat edge) {
  if (!image) return nil;
  NSSize size = NSMakeSize(edge, edge);
  NSImage *scaled = [[NSImage alloc] initWithSize:size];
  [scaled lockFocus];
  [[NSGraphicsContext currentContext] setImageInterpolation:NSImageInterpolationHigh];
  [image drawInRect:NSMakeRect(0, 0, edge, edge)
           fromRect:NSZeroRect
          operation:NSCompositingOperationCopy
           fraction:1.0];
  [scaled unlockFocus];
  NSBitmapImageRep *rep = [[NSBitmapImageRep alloc]
      initWithBitmapDataPlanes:NULL
                    pixelsWide:(NSInteger)edge
                    pixelsHigh:(NSInteger)edge
                 bitsPerSample:8
               samplesPerPixel:4
                      hasAlpha:YES
                      isPlanar:NO
                colorSpaceName:NSDeviceRGBColorSpace
                   bytesPerRow:0
                  bitsPerPixel:0];
  [NSGraphicsContext saveGraphicsState];
  [NSGraphicsContext setCurrentContext:[NSGraphicsContext graphicsContextWithBitmapImageRep:rep]];
  [scaled drawInRect:NSMakeRect(0, 0, edge, edge)
            fromRect:NSZeroRect
           operation:NSCompositingOperationCopy
            fraction:1.0];
  [NSGraphicsContext restoreGraphicsState];
  return [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
}

char *apple_app_icon_png_base64(const char *bundle_id_utf8) {
  if (!bundle_id_utf8 || !bundle_id_utf8[0]) return NULL;
  @autoreleasepool {
    NSString *bid = [NSString stringWithUTF8String:bundle_id_utf8];
    NSURL *url = [[NSWorkspace sharedWorkspace] URLForApplicationWithBundleIdentifier:bid];
    NSImage *icon = nil;
    if (url.path.length) {
      icon = [[NSWorkspace sharedWorkspace] iconForFile:url.path];
    }
    if (!icon) {
      for (NSRunningApplication *app in NSWorkspace.sharedWorkspace.runningApplications) {
        if ([app.bundleIdentifier isEqualToString:bid]) {
          icon = app.icon;
          break;
        }
      }
    }
    if (!icon) return NULL;
    NSData *png = nsimage_png(icon, 128);
    return nsdata_to_b64_c(png);
  }
}

static CGImageRef cgimage_scaled(CGImageRef src, size_t max_edge) {
  if (!src) return NULL;
  size_t w = CGImageGetWidth(src);
  size_t h = CGImageGetHeight(src);
  if (w == 0 || h == 0) return NULL;
  size_t longEdge = w > h ? w : h;
  if (longEdge <= max_edge) {
    CGImageRetain(src);
    return src;
  }
  CGFloat scale = (CGFloat)max_edge / (CGFloat)longEdge;
  size_t nw = (size_t)MAX(1, (CGFloat)w * scale);
  size_t nh = (size_t)MAX(1, (CGFloat)h * scale);
  CGColorSpaceRef space = CGColorSpaceCreateDeviceRGB();
  CGContextRef ctx = CGBitmapContextCreate(
      NULL, nw, nh, 8, nw * 4, space,
      kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
  CGColorSpaceRelease(space);
  if (!ctx) return NULL;
  CGContextSetInterpolationQuality(ctx, kCGInterpolationMedium);
  CGContextDrawImage(ctx, CGRectMake(0, 0, nw, nh), src);
  CGImageRef out = CGBitmapContextCreateImage(ctx);
  CGContextRelease(ctx);
  return out;
}

static NSData *cgimage_png(CGImageRef image) {
  if (!image) return nil;
  NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithCGImage:image];
  return [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
}

char *apple_app_window_preview_png_base64(int32_t pid, int32_t max_edge) {
  if (pid <= 0) return NULL;
  int edge = max_edge > 64 ? max_edge : 320;
  @autoreleasepool {
    CFArrayRef info = CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
        kCGNullWindowID);
    if (!info) return NULL;

    CGWindowID bestId = kCGNullWindowID;
    int64_t bestArea = 0;
    CFIndex n = CFArrayGetCount(info);
    for (CFIndex i = 0; i < n; i++) {
      CFDictionaryRef d = CFArrayGetValueAtIndex(info, i);
      CFNumberRef pidRef = CFDictionaryGetValue(d, kCGWindowOwnerPID);
      int owner = 0;
      if (!pidRef || !CFNumberGetValue(pidRef, kCFNumberIntType, &owner) || owner != pid) {
        continue;
      }
      CFNumberRef layerRef = CFDictionaryGetValue(d, kCGWindowLayer);
      int layer = 0;
      if (layerRef) CFNumberGetValue(layerRef, kCFNumberIntType, &layer);
      if (layer != 0) continue; // chỉ cửa sổ bình thường

      CFDictionaryRef bounds = CFDictionaryGetValue(d, kCGWindowBounds);
      if (!bounds) continue;
      CGRect rect = CGRectZero;
      if (!CGRectMakeWithDictionaryRepresentation(bounds, &rect)) continue;
      int64_t area = (int64_t)(rect.size.width * rect.size.height);
      if (area < 80 * 80) continue;
      if (area <= bestArea) continue;

      CFNumberRef idRef = CFDictionaryGetValue(d, kCGWindowNumber);
      CGWindowID wid = kCGNullWindowID;
      if (!idRef || !CFNumberGetValue(idRef, kCFNumberIntType, &wid)) continue;
      bestArea = area;
      bestId = wid;
    }
    CFRelease(info);

    if (bestId == kCGNullWindowID) return NULL;

    CGImageRef raw = CGWindowListCreateImage(
        CGRectNull,
        kCGWindowListOptionIncludingWindow,
        bestId,
        kCGWindowImageBoundsIgnoreFraming | kCGWindowImageNominalResolution);
    if (!raw) return NULL;
    CGImageRef scaled = cgimage_scaled(raw, (size_t)edge);
    CGImageRelease(raw);
    if (!scaled) return NULL;
    NSData *png = cgimage_png(scaled);
    CGImageRelease(scaled);
    return nsdata_to_b64_c(png);
  }
}

void apple_apps_free(char *p) {
  if (p) free(p);
}
