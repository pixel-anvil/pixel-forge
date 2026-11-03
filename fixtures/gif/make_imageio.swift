// Writes the macOS ImageIO GIF fixtures of card E6.1 (Apple's own GIF encoder, not ours) and the
// expected hashes of their frames.
//
// Run: swiftc -O make_imageio.swift -o /tmp/make_imageio && /tmp/make_imageio <out-dir>
//
// The expected frames are the RGBA arrays built below (opaque or fully transparent pixels only), so the
// pinned hashes do not depend on any GIF decoder. Hash: sha256 of width (u32 BE), height (u32 BE), then
// the RGBA bytes, as the TypeScript `hashRGBA` does.
// Licence: this script and the GIF it writes are ours, released under CC0 1.0.
import Foundation
import CoreGraphics
import ImageIO
import CryptoKit
import UniformTypeIdentifiers

let W = 20
let H = 16
typealias Px = (UInt8, UInt8, UInt8, UInt8)
let T: Px = (0, 0, 0, 0)
let RED: Px = (220, 40, 40, 255)
let GRN: Px = (40, 200, 70, 255)
let YEL: Px = (240, 220, 40, 255)
let BLU: Px = (40, 90, 220, 255)

func frame(_ i: Int, _ c: Px) -> [UInt8] {
    var buf = [UInt8](repeating: 0, count: W * H * 4)
    func put(_ x: Int, _ y: Int, _ p: Px) {
        let o = (y * W + x) * 4
        buf[o] = p.0; buf[o + 1] = p.1; buf[o + 2] = p.2; buf[o + 3] = p.3
    }
    // a box that moves right and down, with a one-pixel BLU corner mark; the rest stays transparent
    for y in 0..<5 { for x in 0..<6 { put(2 + 3 * i + x, 2 + i + y, c) } }
    put(2 + 3 * i, 2 + i, BLU)
    return buf
}

func image(_ buf: [UInt8]) -> CGImage {
    var data = buf
    let ctx = data.withUnsafeMutableBytes { raw in
        CGContext(
            data: raw.baseAddress, width: W, height: H, bitsPerComponent: 8, bytesPerRow: W * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    }
    return ctx.makeImage()!
}

func sha(_ buf: [UInt8]) -> String {
    var d = Data()
    for v in [W, H] { d.append(contentsOf: [UInt8(v >> 24 & 255), UInt8(v >> 16 & 255), UInt8(v >> 8 & 255), UInt8(v & 255)]) }
    d.append(contentsOf: buf)
    return SHA256.hash(data: d).map { String(format: "%02x", $0) }.joined()
}

let out = CommandLine.arguments[1]
let colours = [RED, GRN, YEL, BLU]
let delays = [0.1, 0.2, 0.05, 0.5]
let frames = colours.enumerated().map { frame($0.offset, $0.element) }

let url = URL(fileURLWithPath: out + "/imageio_anim.gif") as CFURL
let dest = CGImageDestinationCreateWithURL(url, UTType.gif.identifier as CFString, frames.count, nil)!
CGImageDestinationSetProperties(
    dest, [kCGImagePropertyGIFDictionary as String: [kCGImagePropertyGIFLoopCount as String: 0]] as CFDictionary)
for (i, f) in frames.enumerated() {
    CGImageDestinationAddImage(
        dest, image(f),
        [kCGImagePropertyGIFDictionary as String: [kCGImagePropertyGIFDelayTime as String: delays[i]]] as CFDictionary)
}
precondition(CGImageDestinationFinalize(dest))

let hashes = frames.map(sha).map { "\"\($0)\"" }.joined(separator: ", ")
let json = "{\"width\": \(W), \"height\": \(H), \"durationsMs\": [100, 200, 50, 500], \"loopCount\": 0, \"hashes\": [\(hashes)]}\n"
try! json.write(toFile: out + "/imageio_expected.json", atomically: true, encoding: .utf8)
