import AppKit
import Foundation
import UniformTypeIdentifiers

private let protocolVersion = 1
private let testPasteboardPrefix = "com.openai.clipboard-adapter-test."

private enum Operation: String {
    case count
    case read
}

private enum FailureCategory: String {
    case noImage = "no-image"
    case multipleImages = "multiple-images"
    case decodeFailed = "decode-failed"
}

private func writeResponse(_ header: [String: Any], body: Data? = nil) {
    guard
        let headerData = try? JSONSerialization.data(withJSONObject: header),
        let newline = "\n".data(using: .utf8)
    else {
        exit(3)
    }
    let output = FileHandle.standardOutput
    output.write(headerData)
    output.write(newline)
    if let body {
        output.write(body)
    }
}

private func writeFailure(_ category: FailureCategory) -> Never {
    writeResponse([
        "protocolVersion": protocolVersion,
        "kind": "failure",
        "category": category.rawValue
    ])
    exit(0)
}

private func selectedPasteboard(arguments: [String]) -> NSPasteboard? {
    if arguments.count == 1 {
        return .general
    }
    guard
        arguments.count == 3,
        arguments[1] == "--test-pasteboard",
        arguments[2].hasPrefix(testPasteboardPrefix)
    else {
        return nil
    }
    return NSPasteboard(name: NSPasteboard.Name(arguments[2]))
}

private let arguments = Array(CommandLine.arguments.dropFirst())
guard
    let operationName = arguments.first,
    let operation = Operation(rawValue: operationName),
    let pasteboard = selectedPasteboard(arguments: arguments)
else {
    exit(2)
}

let observedChangeCount = pasteboard.changeCount
if operation == .count {
    writeResponse([
        "protocolVersion": protocolVersion,
        "kind": "count",
        "changeCount": observedChangeCount
    ])
    exit(0)
}

struct ImageItem {
    let item: NSPasteboardItem
    let imageTypes: [NSPasteboard.PasteboardType]
}

var imageItems: [ImageItem] = []
for item in pasteboard.pasteboardItems ?? [] {
    let imageTypes = item.types.filter { pasteboardType in
        guard let type = UTType(pasteboardType.rawValue) else {
            return false
        }
        return type.conforms(to: .image)
    }
    if imageTypes.isEmpty {
        continue
    }
    imageItems.append(ImageItem(item: item, imageTypes: imageTypes))
}

guard !imageItems.isEmpty else {
    writeFailure(.noImage)
}
guard imageItems.count == 1 else {
    writeFailure(.multipleImages)
}

let imageItem = imageItems[0]
let image = imageItem.imageTypes.lazy.compactMap { imageType -> NSImage? in
    guard let imageData = imageItem.item.data(forType: imageType) else {
        return nil
    }
    return NSImage(data: imageData)
}.first
guard
    let image,
    let tiffData = image.tiffRepresentation,
    let bitmap = NSBitmapImageRep(data: tiffData),
    let pngData = bitmap.representation(using: .png, properties: [:])
else {
    writeFailure(.decodeFailed)
}

writeResponse([
    "protocolVersion": protocolVersion,
    "kind": "image",
    "changeCount": observedChangeCount,
    "imageItemCount": 1,
    "imageRepresentationCount": imageItem.imageTypes.count,
    "pngByteLength": pngData.count
], body: pngData)
