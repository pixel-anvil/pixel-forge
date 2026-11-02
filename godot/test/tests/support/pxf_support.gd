extends RefCounted
## Shared helpers for the importer tests. The "oracle" helpers read the .pxf with a plain
## ZIPReader and `Image.load_png_from_buffer`, not with the addon's reader, so the addon is
## checked against an independent decode of the same bytes.

const Reader := preload("res://addons/pixel_forge/pxf_reader.gd")
const Asset := preload("res://addons/pixel_forge/pixel_forge_asset.gd")

const WALKER := "res://fixtures/walker.pxf"
const SKINS := "res://fixtures/skins.pxf"
const EXPECTED := "res://fixtures/expected.json"


## `expected.json`, written by fixtures/src/godot.ts from the generator's own rectangle lists.
static func expected() -> Dictionary:
	return JSON.parse_string(FileAccess.get_file_as_string(EXPECTED))


## Plain ZIPReader read of one entry.
static func zip_bytes(pxf: String, entry: String) -> PackedByteArray:
	var zip := ZIPReader.new()
	assert(zip.open(pxf) == OK)
	var bytes := zip.read_file(entry)
	zip.close()
	return bytes


static func zip_index(pxf: String) -> Dictionary:
	return JSON.parse_string(zip_bytes(pxf, "render/index.json").get_string_from_utf8())


## Plain decode of `render/<skin>/<image>`.
static func zip_png(pxf: String, skin: String, image: String) -> Image:
	var img := Image.new()
	assert(img.load_png_from_buffer(zip_bytes(pxf, "render/%s/%s" % [skin, image])) == OK)
	img.convert(Image.FORMAT_RGBA8)
	return img


## The authored frames of the index in the order the asset must list them (sorted group,
## direction, index): `[{key: "group/direction/n", image: "<path in the index>"}]`.
static func authored_frames(index: Dictionary) -> Array[Dictionary]:
	var out: Array[Dictionary] = []
	var groups: Array = index["animations"].keys()
	groups.sort()
	for g: String in groups:
		var dirs: Array = index["animations"][g].keys()
		dirs.sort()
		for d: String in dirs:
			var entry: Dictionary = index["animations"][g][d]
			if not entry.has("frames"):
				continue
			var n := 0
			for f: Dictionary in entry["frames"]:
				out.append({"key": "%s/%s/%d" % [g, d, n], "image": f["image"]})
				n += 1
	return out


## Builds an asset with the addon, failing the test run loudly on an error.
static func build(pxf: String, options: Dictionary = {}) -> PixelForgeAsset:
	var reader := Reader.new()
	assert(reader.open(pxf) == OK, reader.error_message)
	var report: Dictionary = {}
	var asset := Asset.build(reader, options, report)
	reader.close()
	assert(asset != null, str(report.get("errors")))
	return asset


## Rebuilds a canvas-sized frame from the atlas: the region pasted at `offset_px` on a transparent
## canvas.
static func canvas_frame(asset: PixelForgeAsset, skin: StringName, frame_index: int) -> Image:
	var f: Dictionary = asset.frames[frame_index]
	var region: Rect2i = f["region"]
	var atlas: Image = asset.atlases[skin].get_image()
	var canvas := Image.create_empty(asset.canvas_size.x, asset.canvas_size.y, false, Image.FORMAT_RGBA8)
	canvas.blit_rect(atlas, region, f["offset_px"])
	return canvas


## Whether every pixel of `img` outside `rect` is fully transparent.
static func transparent_outside(img: Image, rect: Rect2i) -> bool:
	for y in img.get_height():
		for x in img.get_width():
			if not rect.has_point(Vector2i(x, y)) and img.get_pixel(x, y).a != 0.0:
				return false
	return true


## The `[x, y, w, h]` of an `expected.json` box as a Rect2i (null box: not valid, check first).
static func box_rect(box: Array) -> Rect2i:
	return Rect2i(int(box[0]), int(box[1]), int(box[2]), int(box[3]))
